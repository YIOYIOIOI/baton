// 文件：上传到会话工作目录、回读上传的文件、浏览与下载工作目录里的文件。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { inScope } from '../../scope.js';
import { saveUpload, readUpload, MAX_BYTES } from '../../upload.js';
import { listInCwd, openInCwd } from '../../sessionfs.js';
import { mimeOf } from '../static.js';
import { errorBody } from '../errors.js';

/**
 * 列会话工作目录里的一层。
 *
 * 范围锁在**这个会话的工作目录子树**（见 src/sessionfs.js 抬头）。对 owner 这是
 * 界面上的取舍而非安全边界——他建会话时就能指定任意目录；对访客它是真边界，
 * 因为他的 cwd 本来就被 roots 锁住了。
 */
export function listSessionFiles({ repo, key, path: rel, list = listInCwd }) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  if (!member.cwd) {
    return {
      status: 400,
      body: errorBody('no_cwd', '这个会话没有工作目录，没有可浏览的文件。',
        '在电脑上于某个项目目录里新建一个会话。'),
    };
  }
  try {
    return { status: 200, body: { cwd: member.cwd, ...list(member.cwd, rel) } };
  } catch (err) {
    if (err.code === 'OUTSIDE') {
      return {
        status: 403,
        body: errorBody('outside_cwd', '这个路径不在该会话的工作目录里。',
          '文件浏览只在会话自己的目录里，换一条路径。'),
      };
    }
    if (err.code === 'NOTDIR') {
      return { status: 400, body: errorBody('not_a_dir', '这是个文件，不是目录。', '用下载端点取它。') };
    }
    return {
      status: 404,
      body: errorBody('no_such_dir', '没有这个目录。', '它可能已经被移走或删掉了，回上一层看看。'),
    };
  }
}

/**
 * 下载会话工作目录里的一个文件。
 *
 * 和 `downloadUpload` 一样自己接管 `res` 并返回 null——走 JSON 要背 33% 的 base64。
 * 区别只在范围：那个只认 `.baton-uploads/` 下的文件名，这个是整棵工作目录子树。
 */
export function downloadSessionFile({ repo, key, path: rel, res, open = openInCwd, mime = mimeOf }) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  if (!member.cwd) {
    return { status: 400, body: errorBody('no_cwd', '这个会话没有工作目录。', '换一个有工作目录的会话。') };
  }
  let file;
  try {
    file = open(member.cwd, rel);
  } catch (err) {
    if (err.code === 'OUTSIDE') {
      return {
        status: 403,
        body: errorBody('outside_cwd', '这个路径不在该会话的工作目录里。', '只能取这个会话目录下的文件。'),
      };
    }
    // 不存在、是目录、读不动——对调用方都是「取不到」，不分得更细
    return { status: 404, body: errorBody('no_such_file', '取不到这个文件。', '回上一层看看它还在不在。') };
  }
  res.writeHead(200, {
    'Content-Type': mime(file.name),
    'Content-Length': file.size,
    /**
     * `attachment` + 原文件名：点了就是下载，而不是在浏览器里打开一个 .js 当文本看。
     * 文件名走 RFC 5987 的 `filename*`，否则中文名到了浏览器里就是乱码。
     */
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    ...UNTRUSTED_FILE,
    // 工作目录里的文件**会变**，不能像上传那样永久缓存
    'Cache-Control': 'private, no-cache',
  });
  // 一段一段流出去，不整个读进内存（见 sessionfs.openInCwd）。pipeline 负责两头的收尾：
  // 客户端中途断开、或者读到一半出错，都会关掉 fd、断开连接，不留半截
  pipeline(fs.createReadStream(file.full, { fd: file.fd }), res, () => {});
  return null;
}

/**
 * 把传上去的文件读回来，给手机出缩略图。
 *
 * **这是个读取面，所以只读它自己写出去过的东西**：能读到的集合由
 * `readUpload` 里那套和写入完全相同的校验决定（safeName + realpath 包含性），
 * 不多一个字节。详见 `src/upload.js` 抬头那一节。
 *
 * 不归在 allowSend 之下——那是**写入**权限。只读模式下看自己传过的图是合理的，
 * 而且这些字节本来就是从这台手机发出去的。
 *
 * 直接把字节写进 `res` 并返回 null（SSE 那条路一样的约定）：走 JSON 要背 33%
 * 的 base64，而这条路上跑的是手机流量。
 */
/**
 * 回给浏览器的「别人放进来的文件」一律带的两个头。
 *
 * 这些文件不是我们写的（访客上传、agent 生成），却从 App 同一个源上发出去。
 * `nosniff` 让浏览器别自己猜类型——猜成 HTML 就能跑脚本；CSP `sandbox` 兜最后
 * 一层：就算被当成页面直接打开，它也是一个没有脚本、拿不到 cookie 的隔离源。
 * 图片嵌在 `<img>` 里不受这两个头影响。
 */
const UNTRUSTED_FILE = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
};

/** 可以直接在页面里显示的类型：只有常见位图。SVG 能带脚本，不在其中。 */
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

export function downloadUpload({ repo, key, name, res, read = readUpload, mime = mimeOf }) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  if (!member.cwd) {
    return { status: 400, body: errorBody('no_cwd', '这个会话没有工作目录。', '换一个有工作目录的会话。') };
  }
  let file;
  try {
    file = read({ cwd: member.cwd, name });
  } catch (err) {
    if (err?.code === 'UPLOAD_TOO_LARGE') {
      return {
        status: 413,
        body: errorBody('upload_too_large', err.message, '直接在工作目录的电脑本地打开这个大文件。'),
      };
    }
    // 不区分「不存在」「越界」「不是文件」——对调用方都是同一句话，
    // 而分得太细等于把目录结构讲给探测方听
    return { status: 404, body: errorBody('no_such_upload', '没有这个文件。', '它可能已经被移走或删掉了。') };
  }
  const type = mime(file.name);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': file.bytes.length,
    ...UNTRUSTED_FILE,
    /*
      只有常见位图直接显示（聊天里的缩略图靠它），别的一律当下载。
      原来按扩展名给类型、全部在页面里直接打开：.html / .svg 会在我们的源上跑脚本、
      带着看的人的 cookie——访客传一个上来诱 owner 点开，就能替自己铸一个 owner 的
      配对码，工作区隔离当场失效（2026-10-01 审查）。
    */
    ...(INLINE_IMAGE.has(type.split(';')[0].trim())
      ? {}
      : { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` }),
    // 传上去的文件按内容寻址不了，但它**不会被改**（同名不覆盖，见 uniquePath），
    // 所以可以让手机长期缓存——省的正是重复下载同一张图的流量
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  res.end(file.bytes);
  return null;
}

/**
 * 收一个文件，落到这个会话工作目录下的 .baton-uploads/。
 *
 * 归在 allowSend 之下：它往 owner 的磁盘上写东西，权限只会比发消息更重，不会更轻。
 * 返回的 `relative` 是给人往消息里贴的——agent 认的是路径，不是附件。
 */
export function uploadFile({ repo, config, key, name, bytes, save = saveUpload }) {
  if (config.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '传文件需要写入权限，当前为只读模式。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  if (!member.cwd) {
    return {
      status: 400,
      body: errorBody('no_cwd', '这个会话没有工作目录，文件无处存放。',
        '在电脑上于某个项目目录里新建一个会话，再从那里传。'),
    };
  }
  try {
    const r = save({ cwd: member.cwd, name, bytes });
    return {
      status: 201,
      body: {
        ...r,
        note: `已存到 ${r.relative}。在消息里写上这个路径，agent 才会去读它。`,
      },
    };
  } catch (err) {
    return {
      status: 400,
      body: errorBody('upload_failed', err.message,
        `确认工作目录 ${member.cwd} 存在且可写，文件不超过 ${MAX_BYTES / 1048576} MB。`),
    };
  }
}

/**
 * 传文件到一个**工作目录**，而不是一个会话。
 *
 * ## 为什么要有这条
 *
 * 新建会话那一屏要能带附件。但 `createSession` 是「建会话 + 跑第一轮」一次做完的，
 * 而 agent **只认磁盘路径**——附件路径必须出现在第一条消息里。于是顺序只能是
 * 「先传、再带着路径建会话」，而那一刻还没有 session key 可用。
 *
 * owner 的原话：「文件为什么不能随着第一条消息发出去？或者说第一条消息为什么不能
 * 是单纯发文件？」——按 key 那条路做不到，因为 key 还不存在。
 *
 * ## 它不比「在这个目录建会话」多给任何权限
 *
 * 判据逐条照抄 createSession 对 cwd 的那三条，再加上同一道写入闸：
 *
 *   allowSend ∧ 绝对路径 ∧ inScope(roots) ∧ 目录已存在
 *
 * 能在某个目录起 agent 的人，本来就能让文件被写进那个目录——agent 自己就在那儿写，
 * 而 Baton 不传任何沙箱参数。所以这条端点的可达集合恰好等于「他能建会话的地方」，
 * 不多一个字节。对访客仍然被 roots 锁死。
 *
 * 落盘那一层原样走 `saveUpload`，与按 key 那条**完全同一段代码**：safeName 压成
 * 叶子名、realpath 确认仍在 cwd 之内、同名不覆盖、大小上限。这里一个字节的
 * 路径拼接都不做。
 *
 * **不替人建目录**：目录不存在就是 400。建出来是另一件事（POST /api/dirs），
 * 而在这里顺手 mkdir 等于让一个上传端点能在 roots 下造任意目录树。
 */
export function uploadToCwd({ config, principal, cwd, name, bytes, save = saveUpload }) {
  if (config.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '传文件需要写入权限，当前为只读模式。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) {
    return {
      status: 400,
      body: errorBody('bad_cwd', `工作目录必须是绝对路径（收到 ${JSON.stringify(cwd)}）。`,
        '用 GET /api/dirs 浏览可选目录。'),
    };
  }
  const dir = path.resolve(cwd);
  if (!inScope(dir, principal?.roots ?? null)) {
    return {
      status: 403,
      body: errorBody('cwd_not_allowed', `工作目录不在你的工作区里：${dir}`,
        `你的工作区是 ${principal.roots.join('、')}，只能往它下面传。`),
    };
  }
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      status: 400,
      body: errorBody('cwd_not_found', `目录不存在：${dir}`,
        '先用 POST /api/dirs 把它建出来。'),
    };
  }
  try {
    const r = save({ cwd: dir, name, bytes });
    return {
      status: 201,
      body: {
        ...r,
        note: `已存到 ${r.relative}。在消息里写上这个路径，agent 才会去读它。`,
      },
    };
  } catch (err) {
    return {
      status: 400,
      body: errorBody('upload_failed', err.message,
        `确认 ${dir} 可写，文件不超过 ${MAX_BYTES / 1048576} MB。`),
    };
  }
}
