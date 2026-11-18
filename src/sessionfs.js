import fs from 'node:fs';
import path from 'node:path';

/**
 * 会话工作目录里的文件浏览与读取。
 *
 * ## 这是一个新的读取面，所以边界写在一处
 *
 * 能碰到的东西**恰好等于「这个会话的工作目录子树」**，一个字节都不多。做法和
 * `upload.js` 的 `uploadTarget()` 同一套，也只有这一套值得信：
 *
 *   1  **两边都取 realpath 再比。** 不用 `path.resolve` 的字符串结果——它不解析
 *      符号链接。这个区别不是理论上的：静态资源那道闸就栽在这上面，注释里写着
 *      防符号链接，实际上一个 junction 就能穿过去（见 upload.js 抬头）。
 *   2  比的时候带上分隔符（`root + sep`），否则 `C:\work2` 会被 `C:\work`
 *      的前缀判断放行。
 *
 * ## 关于「这挡得住谁」
 *
 * **挡不住 owner，也不打算挡。** 他建会话时就能指定任意目录，这个功能没有扩大他
 * 的能力面，只是把它摆出来。对他，子树范围是**界面上的取舍**：每个会话只看自己
 * 那个目录，而不是又给一棵全盘文件树。
 *
 * **对访客它是真边界**：访客的会话 cwd 本来就被 `principals` 的 roots 锁在他自己
 * 的工作区里，子树范围天然继承，不用在这儿再写一遍判断。
 *
 * ## 不隐藏任何东西
 *
 * `.git/`、`node_modules/`、点开头的文件**照列**。藏起来只会让人以为文件丢了，
 * 而这棵树上的东西本来就是那个 agent 随时能读的——藏了也只是自欺。
 */

/** 单个条目。`size`/`mtime` 只对文件有意义，目录给 null。 */
export function entryOf(full, name, st) {
  const dir = st.isDirectory();
  return {
    name,
    dir,
    size: dir ? null : st.size,
    mtime: st.mtimeMs ? Math.round(st.mtimeMs) : null,
  };
}

/**
 * 把一个相对路径解析成绝对路径，并**验证它确实在 cwd 子树里**。
 *
 * @param rel 相对工作目录的路径。空串 / undefined 表示工作目录本身。
 *   反斜杠和正斜杠都收——agent 写出来的路径两种都有，而这是给人点的。
 * @returns {{ root: string, full: string, relative: string }} relative 一律用 `/`，客户端只认这一种。
 */
export function resolveInCwd(cwd, rel) {
  if (!cwd) throw new Error('这个会话没有工作目录。');
  const root = fs.realpathSync(cwd); // cwd 本身不存在就在这里抛，正好

  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  // path.resolve 会把 `..` 折掉，但折出来的结果仍然可能在 root 外面——
  // 所以它只是第一步，真正作数的是下面 realpath 之后那次比较
  const target = path.resolve(root, clean);

  // realpath 要求路径已存在。不存在就是「没有这个东西」，交给调用方转 404
  const full = fs.realpathSync(target);
  // root 自己就以分隔符结尾时（会话建在盘根 `C:\`、或 posix 的 `/`）不能再加一个：
  // `C:\` + `\` = `C:\\`，盘根下的任何东西都不以它开头，于是整棵树都被当成「越界」
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw Object.assign(new Error('越出了这个会话的工作目录。'), { code: 'OUTSIDE' });
  }

  const relative = path.relative(root, full).split(path.sep).join('/');
  return { root, full, relative };
}

/**
 * 列一层。目录在前、文件在后，各自按名字排。
 *
 * 逐项 stat 且**不抛**：一棵真实的工作目录里一定有读不动的东西（占用中的文件、
 * 权限不够的目录），它们不能让整个请求失败——跳过就是了，列表本身还有用。
 */
export function listInCwd(cwd, rel) {
  const { full, relative } = resolveInCwd(cwd, rel);
  const st = fs.statSync(full);
  if (!st.isDirectory()) {
    throw Object.assign(new Error('这是个文件，不是目录。'), { code: 'NOTDIR' });
  }

  const entries = [];
  for (const ent of fs.readdirSync(full, { withFileTypes: true })) {
    try {
      // 用 statSync 而不是 ent.isDirectory()：符号链接要按**指向的东西**归类，
      // 否则一个指向目录的链接会被当成文件，点进去什么都没有
      entries.push(entryOf(path.join(full, ent.name), ent.name, fs.statSync(path.join(full, ent.name))));
    } catch {
      // 读不动的跳过，不让它拖垮整个列表
    }
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));

  // parent 为 null 表示「到顶了」——工作目录就是这个会话能看到的天花板
  const parent = relative === '' ? null : (path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
  return { path: relative, parent, entries };
}

/**
 * 打开一个文件给下载用：解析路径、校验、打开，**不读内容**。返回打开的 fd，由调用方流出去再关。
 *
 * 原来是 readFileSync 整个读进来（2026-10-01 审查）：工作目录里什么都可能有——数据库、
 * 视频、构建产物——1.5 GB 的文件就是 1.5 GB 内存，读的时候整个守护进程卡住，
 * 超过 2 GB 还会抛 ERR_FS_FILE_TOO_LARGE、被当成 404。
 *
 * 在这里就打开，而不是让流自己去开：Windows 上被别的程序锁着的文件（正在用的数据库）
 * 打开会失败，要在发响应头**之前**知道，才回得了一个清楚的错误。
 */
export function openInCwd(cwd, rel) {
  const { full, relative } = resolveInCwd(cwd, rel);
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    throw Object.assign(new Error('这是个目录，不是文件。'), { code: 'ISDIR' });
  }
  if (!st.isFile()) {
    throw Object.assign(new Error('只支持读取普通文件。'), { code: 'ENOTFILE' });
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fs.openSync(full, flags);
  // Close immediately on fstat failure or non-regular file so the daemon never leaks FDs.
  try {
    const fst = fs.fstatSync(fd);
    if (typeof fst.isFile === 'function' && !fst.isFile()) {
      throw Object.assign(new Error('只支持读取普通文件。'), { code: 'ENOTFILE' });
    }
    return { fd, full, name: path.basename(full), size: fst.size, relative };
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore close errors */ }
    throw err;
  }
}
