import fs from 'node:fs';
import path from 'node:path';

// 跳过 A: / B:——历史软驱位，某些机器上探测会卡住好几秒
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** 可用的盘符。非 win32 上返回文件系统根，保证起点页面永不为空。 */
export function listDrives() {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/', readable: true }];
  }
  const out = [];
  for (const L of DRIVE_LETTERS) {
    const root = `${L}:\\`;
    try {
      fs.statSync(root);
      out.push({ name: `${L}:`, path: root, readable: true });
    } catch {
      // 没有这个盘
    }
  }
  return out;
}

/**
 * 探测一个目录能不能进去。
 *
 * 用 opendirSync 而不是 readdirSync：只开一个句柄，不读内容。
 * 同样能测出权限问题，但对 node_modules 那种上千条目的目录便宜得多——
 * 这个探测对父目录下的**每一个**子目录都要跑一次。
 */
function probeReadable(full) {
  let d = null;
  try {
    d = fs.opendirSync(full);
    return true;
  } catch {
    return false;
  } finally {
    try {
      d?.closeSync();
    } catch {
      // 没开成就没得关
    }
  }
}

/**
 * 列出 target 下的子目录。**只列目录，不列文件**——这个接口是用来选工作目录的，
 * 文件树是 spec §18 明确不做的。
 *
 * 逐项探测且不抛：owner 的无限制视图里一定会遇到 `C:\System Volume Information`、
 * `$Recycle.Bin` 这类读不动的目录，它们**不能让整个请求失败**，只标记出来。
 */
export function listDirs(target, { probe = probeReadable } = {}) {
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const full = path.join(target, ent.name);
    out.push({ name: ent.name, path: full, readable: probe(full) });
  }
  // 不过滤隐藏目录：`.claude/worktrees/*` 就在里面，而实测那是真实的工作目录
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
