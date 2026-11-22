import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './scope.js';
import { inWebRoot } from './http/static.js';
import { canonicalCwd, openVerifiedFile } from './sessionfs.js';

/**
 * 从手机传文件到那台电脑。
 *
 * 为什么是「写进项目目录」而不是「把附件塞给 agent」：两个 CLI 都**只从磁盘按路径读文件**，
 * 非交互模式下消息走 stdin，没有任何附件通道。所以唯一能让 agent 真正看到这个文件的办法，
 * 就是先把它落到它读得到的地方，再在消息里写上路径。
 *
 * 落在 cwd 下的 `.baton-uploads/`，不落在 ~/.baton：Claude Code 与 Codex 默认都把
 * 读写限制在工作目录内，放到工作目录之外大概率被它们自己的权限层挡掉——
 * 那样传是传上去了，agent 说看不见，人只会以为 Baton 坏了。
 */

export { UPLOAD_DIR };
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 客户端发消息时，附件路径以这个抬头开一段拼在正文末尾。
 *
 * 那段是**写给 agent 的**（两个 CLI 都只认磁盘路径），不该给人看。服务端本来
 * 不需要知道它——直到发现**会话标题**是从第一条消息派生的：于是「只回复两个字：
 * 收到」那条会话，在侧栏和页头上显示成
 *
 *     只回复两个字：收到 附件（已放在工作目录下）： - .baton-uploads/report.xlsx（12 B） - …
 *
 * 在服务端切掉，三端一次都对；放到各客户端去切就是三份各写一遍。
 *
 * 这是 app / web / 服务端三处共用的**协议**，`test/attach-format.test.js`
 * 会把三边的字面量放在一起比对，防漂移。
 */
export const ATTACH_HEADING = '附件（已放在工作目录下）：';

/**
 * 去掉末尾那段附件清单，只留正文。
 *
 * 认的是客户端 `attachmentSuffix()` 写出去的那个格式，不做通用解析：要求它
 * **出现在末尾**、且后面每一行都是 `- 路径（大小）`。任一条不满足就原样返回
 * ——宁可标题里多几个字，也不要把用户真写的话切掉。
 */
export function stripAttachmentList(text) {
  const s = String(text ?? '');
  const marker = `\n\n${ATTACH_HEADING}\n`;
  const head = `${ATTACH_HEADING}\n`;

  /*
    两种形状都要认：
      正文 + "\n\n" + 抬头 + 清单     —— 有正文的时候
      抬头 + 清单                     —— **只发文件、一个字没写**

    后一种是客户端 `suffix.trimStart()` 出来的：正文为空时那两个前导换行没有
    意义，被它去掉了。只认前一种的话，纯附件消息的清单会原样显示成标题和正文
    ——而「第一条消息可以只是几个文件」正是刚加的能力。
  */
  const at = s.lastIndexOf(marker);
  const from = at >= 0 ? at + marker.length : (s.startsWith(head) ? head.length : -1);
  if (from < 0) return { body: s, files: [] };
  const bodyEnd = at >= 0 ? at : 0;

  const files = [];
  for (const line of s.slice(from).split('\n')) {
    if (!line.trim()) continue;
    // 路径允许有空格：safeName 不删空格，`我的 文件.txt` 是合法落盘名
    const m = /^-\s+(.+?)（[^）]*）$/.exec(line.trim());
    if (!m) return { body: s, files: [] };
    files.push(m[1].split(/[\\/]/).pop() || m[1]);
  }
  return files.length ? { body: s.slice(0, bodyEnd), files } : { body: s, files: [] };
}

/**
 * 把文件名压成安全的叶子名。
 *
 * 这里要挡的不是「难看的名字」，是**目录穿越**：`../../.ssh/authorized_keys`、
 * Windows 的 `..\\`、以及 NUL 截断。做法是只取 basename 再洗一遍字符，
 * 而不是去匹配「坏模式」——黑名单总有漏的，白名单没有。
 */
export function safeName(raw) {
  let n = String(raw ?? '').replace(/\0/g, '');
  // 两种分隔符都切：名字可能来自任一端的系统
  n = n.split(/[\\/]/).pop() ?? '';
  // 控制字符、Windows 保留字符、前导点一律去掉。前导点要去是因为
  // `.bashrc` 这类名字落进项目目录里是有后果的。
  // oxlint-disable-next-line no-control-regex -- 要去掉的正是控制字符
  n = n.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').replace(/^\.+/, '').trim();
  // Windows 上以点或空格结尾的名字创建出来会被悄悄截断，名字就对不上了
  n = n.replace(/[. ]+$/, '');
  if (!n) return null;
  if (n.length > 100) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 100 - ext.length) + ext;
  }
  // Windows 设备名：真去创建 `CON` 会得到一个设备句柄而不是文件
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  return n;
}

/**
 * 让上传目录忽略自己。
 *
 * 落点在用户的项目目录里，多半是个 git 仓库。不管的话，从手机传上去的文件
 * 会出现在 `git status` 里，跟着下一次 `git add .` 一起提交——而那些文件
 * 很可能是不该进版本库的（截图、日志、别人发来的资料）。
 *
 * 写在目录**自己**里面，不碰用户的 .gitignore：改别人的配置文件是越界的，
 * 而自忽略目录是这件事的标准做法，删掉整个目录就什么痕迹都不留。
 */
function ignoreSelf(dir) {
  const f = path.join(dir, '.gitignore');
  if (lexicalExists(f)) return;
  try {
    fs.writeFileSync(
      f,
      '# Baton 从手机传上来的文件，默认不进版本库。\n# 要提交某个文件，把它移出这个目录。\n*\n',
      { flag: 'wx' },
    );
  } catch {
    // 写不进去（包括已存在/悬空链接等）不影响传文件本身
  }
}

/**
 * 确定落盘位置，并验证它确实在**给定的这个 cwd** 里面。
 *
 * 用 realpath 而不是 path.resolve：resolve 只做字符串归一化，不解析符号链接。
 * 这个区别不是理论上的——之前静态资源那道闸就是栽在这上面，注释里写着防符号链接，
 * 实际上一个 junction 就能穿过去。所以这里对**两边都取 realpath 之后再比**。
 *
 * 调用方按访客的工作区验证 cwd。创建附件前还要排除公开资源目录，避免文件经静态服务公开。
 */
export function uploadTarget(cwd, rawName, { mkdir = true, webRoots = undefined, pinnedCwd = false } = {}) {
  const name = safeName(rawName);
  if (!name) throw new Error('文件名为空或全是非法字符。');
  if (!cwd) throw new Error('这个会话没有工作目录，无处存放。');

  const realCwd = canonicalCwd(cwd, pinnedCwd);
  const dir = path.join(realCwd, UPLOAD_DIR);
  if (mkdir && inWebRoot(dir, webRoots)) {
    throw Object.assign(new Error('客户端公开资源目录不能存放附件。'), { code: 'PUBLIC_UPLOAD_DIR' });
  }
  let createdDir = false;
  if (mkdir && !lexicalExists(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    createdDir = true;
  }

  let dirLst = null;
  try {
    dirLst = fs.lstatSync(dir);
  } catch (err) {
    if (!mkdir) throw err;
  }

  // realpath 要求路径已存在，所以只对目录做——文件还没写出来
  const realDir = fs.realpathSync.native(dir);
  if (realDir !== path.join(realCwd, UPLOAD_DIR)
    && !realDir.startsWith(realCwd + path.sep)) {
    throw new Error(`${UPLOAD_DIR} 指向了工作目录之外，拒绝写入。`);
  }
  if (dirLst?.isSymbolicLink()) {
    throw new Error(`${UPLOAD_DIR} 为符号链接（存在越出工作目录风险），拒绝访问。`);
  }
  if (mkdir || createdDir) ignoreSelf(realDir);

  const full = path.join(realDir, name);
  // 名字已经过 basename + 洗字符，这里再比一次是廉价的兜底：
  // 上面任何一处将来被改松，这一行仍然拦得住。
  if (path.dirname(full) !== realDir) throw new Error('文件名解析后越出了上传目录。');

  return { dir: realDir, full, name, relative: path.posix.join(UPLOAD_DIR, name) };
}

/**
 * 把刚传上来的文件**读回来**，给手机出缩略图用。
 *
 * owner 要的是「发出去之后图片以预览小图出现在气泡上方」。本地那份 previewUri
 * 只在这次 App 运行期内有效，重载就没了，所以得能从这台电脑取回来。
 *
 * ## 这是一个新增的读取面，所以闸门写死在这儿
 *
 * 复用 `uploadTarget(..., { mkdir: false })`：它做的是**写入**时那套同样的校验——
 * `safeName` 洗掉路径分隔符、realpath 之后确认仍在 cwd 之内。于是这个端点能读到的
 * 集合 **恰好等于**它自己写出去过的集合，不多一个字节：
 *
 *   - `..`、绝对路径、分隔符都被 safeName 吃掉，出不了 .baton-uploads/
 *   - 符号链接/junction 被 realpath 拆穿（注释里那条历史教训就在上面）
 *   - 目录不存在就直接抛，不会顺着往上找
 *
 * **不加 mkdir**：读取不该有副作用，而且目录不存在本身就是「没有可读的东西」。
 */
export async function readUpload({ cwd, name, maxBytes = MAX_BYTES, pinnedCwd = false }) {
  const t = uploadTarget(cwd, name, { mkdir: false, pinnedCwd });
  if (fs.lstatSync(t.full).isSymbolicLink()) throw new Error('拒绝读取符号链接。');
  const file = await openVerifiedFile(t.dir, t.full);
  try {
    if (file.size > maxBytes) {
      throw Object.assign(new Error(`文件过大（超过 ${Math.round(maxBytes / 1048576)} MB 上限）。`), {
        code: 'UPLOAD_TOO_LARGE',
      });
    }
    const bytes = Buffer.allocUnsafe(file.size);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(file.fd, bytes, length, bytes.length - length, length);
      if (!n) break;
      length += n;
    }
    return { bytes: bytes.subarray(0, length), name: t.name, size: length };
  } finally {
    fs.closeSync(file.fd);
  }
}

function lexicalExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

/** 同名不覆盖：追加 -2、-3。覆盖掉用户十分钟前传的同名文件是不可逆的。 */
export function uniquePath(full, { exists = lexicalExists } = {}) {
  if (!exists(full)) return full;
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const base = path.basename(full, ext);
  for (let i = 2; i < 1000; i += 1) {
    const p = path.join(dir, `${base}-${i}${ext}`);
    if (!exists(p)) return p;
  }
  throw new Error('同名文件太多了。');
}

export function saveUpload({ cwd, name, bytes, webRoots = undefined, pinnedCwd = false }) {
  if (!bytes?.length) throw new Error('文件是空的。');
  if (bytes.length > MAX_BYTES) {
    throw new Error(`文件过大（${(bytes.length / 1048576).toFixed(1)} MB，上限 ${MAX_BYTES / 1048576} MB）。`);
  }
  const t = uploadTarget(cwd, name, { webRoots, pinnedCwd });
  let full;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    full = uniquePath(t.full);
    try {
      fs.writeFileSync(full, bytes, { flag: 'wx' });
      break;
    } catch (err) {
      if (err?.code === 'EEXIST' && attempt < 4) continue;
      throw err;
    }
  }
  const finalName = path.basename(full);
  return {
    name: finalName,
    bytes: bytes.length,
    path: full,
    relative: path.posix.join(UPLOAD_DIR, finalName),
  };
}
