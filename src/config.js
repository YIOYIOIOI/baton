import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// BATON_DIR 可由环境变量覆盖，这样测试能被整体重定向到临时目录。
// 逐个调用点注入 dir 的做法已经证明不可靠：漏注入一处，测试数据就写进
// 真实的 ~/.baton/audit.log——而审计日志是「Baton 替我发过什么」的凭据，
// 被合成记录污染就不可信了。见 test/setup.js。
export const BATON_DIR = process.env.BATON_DIR ?? path.join(os.homedir(), '.baton');

// 访客工作区默认放在**盘符根下的专用目录**，既不放仓库里也不放用户目录下。
// 三条依据（完整对照见 specs/2026-09-14-workspace-isolation-design.md §3.1b）：
//   1. 不能放仓库里——v1 §17 git 约定第 3 条已经为 ~/.baton/ 定过同一条规则
//      （「这个布局是有意的，不得为方便挪进仓库」），而且会污染 git status；
//      Codespaces 的 /workspaces 与 Gitpod 的 /workspace 也是同一个模式：
//      工作区是唯一持久化的那层，刻意放在安装路径之外
//   2. 不放用户目录下——Windows 的 MAX_PATH 260 在 node_modules 深嵌套下会真踩到，
//      顶层路径白捡 18 个字符；且这个路径会显示给访客看，不该带上 owner 的用户名
//   3. 常见 Windows 顶层工作区布局（如 C:\projects、C:\workspace 等）
// 非提权进程能否在 C:\ 根建目录已实测通过。
export function defaultWorkspacesRoot(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    return path.win32.join(path.win32.parse(home).root || 'C:\\', 'BatonWorkspaces');
  }
  return path.posix.join(home, 'BatonWorkspaces');
}

const DEFAULT_WORKSPACES_ROOT = defaultWorkspacesRoot();

// devCorsOrigin：开发期让 `expo start --web` 那个页面能跨源调 Baton。
// 默认 null（关闭）。必须填**精确的单一来源**，不接受 '*'——
// 通配等于允许任何网站的脚本调这台 Baton。
// publicUrl：手机能打开的地址（隧道那个主机名）。npm run pair 用它拼二维码里的链接。
// 不设的话退回局域网地址——127.0.0.1 在手机上指向手机自己，用不了。
//
// config.json 里还有两个键不在这张表里、也不走这份启动快照：permissionMode
// （permission.js）和 defaultEffort（runtime/prefs.js）。它们每次用的时候从盘上读，
// 改了不用重启守护进程。
const DEFAULTS = {
  host: '127.0.0.1',
  port: 3002,
  allowSend: true,
  devCorsOrigin: null,
  publicUrl: null,
  workspacesRoot: DEFAULT_WORKSPACES_ROOT,
};

export function loadConfig({ dir = BATON_DIR } = {}) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    // 缺文件或坏文件都退回默认值；不写盘
  }
  return { ...DEFAULTS, ...file };
}

export function ensureToken({ dir = BATON_DIR } = {}) {
  const file = path.join(dir, 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // 不存在则生成
  }
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
