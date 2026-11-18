// 工作目录选择器的后端：浏览、新建目录。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import fs from 'node:fs';
import path from 'node:path';
import { inScope } from '../../scope.js';
import { listDirs, listDrives } from '../../dirs.js';
import { errorBody } from '../errors.js';
import { visibleCwds } from './sessions.js';

function dirEntry(p) {
  return { name: path.basename(p) || p, path: p, readable: true };
}

/**
 * 浏览目录，供客户端做工作目录选择器。
 *
 * 不带 path 时返回的是**一组入口**而不是某个目录的内容，故 path 与 parent 都是 null。
 */
export function browseDirs({ repo, principal, path: target }) {
  const roots = principal?.roots ?? null;

  if (target === null || target === undefined || target === '') {
    const dirs = roots === null
      ? [...listDrives(), ...[...visibleCwds(repo)].sort().map(dirEntry)]
      : roots.map(dirEntry);
    const seen = new Set();
    return {
      status: 200,
      body: {
        path: null,
        parent: null,
        dirs: dirs.filter((d) => !seen.has(d.path) && seen.add(d.path)),
      },
    };
  }

  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    return {
      status: 400,
      body: errorBody('bad_path', `不是绝对路径：${JSON.stringify(target)}`,
        '传完整路径，例如 C:\\workspace 或 /home/user/projects。不带 path 参数则返回可用的起点。'),
    };
  }

  const resolved = path.resolve(target);
  if (!inScope(resolved, roots)) {
    // 这里用 403 而不是 404：路径是调用者自己敲的，告诉他边界在哪更可操作，
    // 且不泄露任何存在性信息——他本来就知道自己传了什么。
    // 会话 key 那条路径相反，用 404，因为 key 不是他敲的。
    return {
      status: 403,
      body: errorBody('outside_workspace', `${resolved} 不在你的工作区里。`,
        `你的工作区是 ${roots.join('、')}，只能浏览它下面的目录。`),
    };
  }

  let dirs;
  try {
    dirs = listDirs(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        status: 404,
        body: errorBody('dir_not_found', `目录不存在：${resolved}`,
          '检查路径拼写，或先用 POST /api/dirs 把它建出来。'),
      };
    }
    return {
      status: 403,
      body: errorBody('dir_unreadable', `这个目录读不了：${resolved}（${err.code ?? err.message}）`,
        '换一个目录。系统目录通常需要管理员权限，而 Baton 是以普通权限跑的。'),
    };
  }

  // parent 为 null 表示「不能再往上」：guest 站在自己 root 上时如此，
  // owner 站在盘符根上时也如此（path.dirname('C:\\') === 'C:\\'）。
  const up = path.dirname(resolved);
  const parent = (up === resolved || !inScope(up, roots)) ? null : up;
  return { status: 200, body: { path: resolved, parent, dirs } };
}

/**
 * 新建目录。
 *
 * 归在 allowSend 之下——它往 owner 的磁盘上写东西，与上传文件是同一条纪律。
 */
export function makeDir({
  config, principal, path: target, mkdir = fs.mkdirSync, stat = fs.statSync,
}) {
  if (config.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '新建目录需要写入权限，当前为只读模式。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  if (typeof target !== 'string' || !target || !path.isAbsolute(target)) {
    return {
      status: 400,
      body: errorBody('bad_path', `不是绝对路径：${JSON.stringify(target)}`,
        '传完整路径，例如 C:\\BatonWorkspaces\\friend\\newproj。'),
    };
  }
  const resolved = path.resolve(target);
  if (!inScope(resolved, principal?.roots ?? null)) {
    return {
      status: 403,
      body: errorBody('outside_workspace', `${resolved} 不在你的工作区里。`,
        `你的工作区是 ${principal.roots.join('、')}，只能在它下面新建目录。`),
    };
  }

  try {
    if (stat(resolved).isDirectory()) {
      // 已经有了不算错误——客户端重试或两台设备同时建时都会走到这里
      return { status: 200, body: { path: resolved, created: false } };
    }
    return {
      status: 400,
      body: errorBody('not_a_directory', `${resolved} 已存在，但不是目录。`, '换一个名字。'),
    };
  } catch {
    // 不存在，继续建
  }

  try {
    mkdir(resolved, { recursive: true });
  } catch (err) {
    return {
      status: 400,
      body: errorBody('mkdir_failed', `建不了 ${resolved}：${err.message}`,
        '确认上级目录存在且可写、盘符正确，且名字里没有 Windows 不允许的字符（\\ / : * ? " < > |）。'),
    };
  }
  return { status: 201, body: { path: resolved, created: true } };
}
