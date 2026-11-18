import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAttachmentList } from './upload.js';
import { normPath } from './scope.js';

/**
 * Return candidate Claude Desktop session registry directories ordered by likelihood across platforms.
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, platform?: string }} [opts]
 * @returns {string[]}
 */
export function claudeRegistryRoots({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA ?? p.join(home, 'AppData', 'Roaming');
    candidates.push(
      p.join(local, 'Claude-3p', 'claude-code-sessions'),
      p.join(local, 'AnthropicClaude', 'claude-code-sessions'),
      p.join(roaming, 'Claude', 'claude-code-sessions'),
    );
  } else if (platform === 'darwin') {
    candidates.push(
      p.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
      p.join(home, 'Library', 'Application Support', 'Claude-3p', 'claude-code-sessions'),
    );
  } else {
    const cfgHome = env.XDG_CONFIG_HOME || p.join(home, '.config');
    candidates.push(
      p.join(cfgHome, 'Claude', 'claude-code-sessions'),
      p.join(cfgHome, 'Claude-3p', 'claude-code-sessions'),
    );
  }
  return [...new Set(candidates)];
}

export const CLAUDE_REGISTRY_ROOT = claudeRegistryRoots()[0];
export const CODEX_STATE_FILE = path.join(os.homedir(), '.codex', '.codex-global-state.json');

/**
 * Codex 的线程名索引：每行 `{id, thread_name, updated_at}`，只追加，改名就再写一行。
 * 和全局状态文件在同一个目录（`~/.codex/`）——从状态文件推，测试给一个临时的
 * 状态文件，索引就自动跟到临时目录，不会读到这台机器上真实的那份。
 */
export function codexIndexFileFor(stateFile) {
  return path.join(path.dirname(stateFile), 'session_index.jsonl');
}

const MAX_DERIVED = 60;

/** App 删会话时在注册项旁边留的墓碑：`deleted_<id>`，内容是删除时刻的毫秒数。 */
const TOMBSTONE = 'deleted_';

function indexDirs(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 备份目录里的条目 cliSessionId 与活动目录重复（实测 3 条），会造成重复身份
    if (/\.backup-/.test(path.basename(dir))) return;
    const files = entries
      .filter((e) => e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json'))
      .map((e) => e.name);
    const tombstones = entries
      .filter((e) => e.isFile() && e.name.startsWith(TOMBSTONE))
      .map((e) => e.name.slice(TOMBSTONE.length));
    if (files.length) out.push({ dir, files, tombstones });
    if (depth < 3) {
      for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

const text = (v) => (typeof v === 'string' && v.trim() ? v : null);

/** App 侧栏标题优先级：优先使用注册项中的 title / spawnedFrom.title / worktreeName。 */
function appTitle(raw) {
  return text(raw.title) ?? text(raw.spawnedFrom?.title) ?? text(raw.worktreeName);
}

/**
 * @typedef {{
 *   title: string | null, titleSource: string | null, isArchived: boolean,
 *   cwd: string | null, project: string | null,
 *   model: string | null, effort: string | null, permissionMode: string | null,
 *   file: string, raw: any,
 * }} AppSession
 */

/**
 * 桌面 App 的会话账本：哪个 transcript 是 App 里的哪一行、哪些已经在 App 里删了。
 *
 * **App 里一行不等于一个 transcript。** 压缩上下文之后 CLI 换新 id 接着写，App 把旧 id
 * 记进 `priorCliSessionIds`——侧栏还是那一行，盘上却多了一个文件。按桌面端格式：
 *
 *   活着的句柄  [cliSessionId, unarchivedCliSessionId]      → sessions
 *   旧段        [preClearCliSessionId, ...priorCliSessionIds] → lineage
 *
 * **删会话只删注册项，transcript 留在盘上**，同目录写 `deleted_<id>` 墓碑——会话自己的
 * id 和它名下每个 transcript 的 id 各一个（App 的删除逻辑里就是这么拼的）。不认墓碑，
 * 在 App 里删掉的会话在 Baton 里就一直在（实测 34 个墓碑，其中 6 个的 transcript 还在）。
 *
 * 同一个 id 若既是某条的旧段、又是另一条的活句柄，按活的算；墓碑同理。
 *
 * @param {{ root?: string, roots?: string[] }} [opts]
 * @returns {{ sessions: Map<string, AppSession>, lineage: Map<string, AppSession>, deleted: Set<string> }}
 */
export function claudeApp({ root, roots } = {}) {
  const sessions = new Map();
  const lineage = new Map();
  const deleted = new Set();
  const scanRoots = roots ?? (root !== undefined ? [root] : claudeRegistryRoots());
  const dirs = scanRoots.flatMap((r) => indexDirs(r));
  if (!dirs.length) return { sessions, lineage, deleted };
  dirs.sort((a, b) => b.files.length - a.files.length);
  const winner = dirs[0];
  for (const name of winner.files) {
    const file = path.join(winner.dir, name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // 坏条目跳过
    }
    if (!raw?.cliSessionId) continue;
    /** @type {AppSession} */
    const entry = {
      title: appTitle(raw),
      titleSource: raw.titleSource ?? null,
      isArchived: raw.isArchived === true,
      cwd: raw.cwd ?? null,
      // 侧栏归组用的目录：`originCwd || cwd`。worktree 会话的 cwd 是
      // <仓库>\.claude\worktrees\<随机名>，originCwd 才是用户选的那个文件夹
      project: text(raw.originCwd) ?? text(raw.cwd),
      model: raw.model ?? null,
      effort: raw.effort ?? null,
      permissionMode: raw.permissionMode ?? null,
      file,
      raw,
    };
    for (const id of [raw.cliSessionId, raw.unarchivedCliSessionId]) {
      if (typeof id === 'string' && !sessions.has(id)) sessions.set(id, entry);
    }
    const prior = Array.isArray(raw.priorCliSessionIds) ? raw.priorCliSessionIds : [];
    for (const id of [raw.preClearCliSessionId, ...prior]) {
      if (typeof id === 'string' && !lineage.has(id)) lineage.set(id, entry);
    }
  }
  for (const id of sessions.keys()) lineage.delete(id);
  for (const id of winner.tombstones) if (!sessions.has(id)) deleted.add(id);
  return { sessions, lineage, deleted };
}

/**
 * 只要活着的那张表：cliSessionId → 注册项。
 * @param {{ root?: string, roots?: string[] }} [opts]
 */
export function claudeRegistry({ root, roots } = {}) {
  return claudeApp({ root, roots }).sessions;
}

/**
 * Codex App 里线程的名字。
 *
 * App 的线程列表优先展示 `name || preview || id`，name 落在 `~/.codex/session_index.jsonl`。
 *
 * 只追加：同一个 id 后写的覆盖先写的（改名）。名字改成空白就回到没名字（App 显示 preview）。
 */
export function codexThreadNames({ file = codexIndexFileFor(CODEX_STATE_FILE) } = {}) {
  const names = new Map();
  let body;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return names;
  }
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // 坏行（比如写到一半）跳过
    }
    if (typeof row?.id !== 'string') continue;
    const name = text(row.thread_name);
    if (name) names.set(row.id, name);
    else names.delete(row.id);
  }
  return names;
}

/**
 * @typedef {{ ids: Set<string>, roots: string[] }} CodexChats
 */

/**
 * Codex App 全局状态里 Baton 用得上的两样：
 *
 *   descriptions  `thread-descriptions-v1`。**不是线程名**——实测唯一一条是
 *                 「回复用户的 ok 请求」，App 显示的名字是「回复 ok」。只给没有
 *                 线程名索引的老版本兜底
 *   chats         「独立聊天」：不归任何项目的线程。名单在 `projectless-thread-ids`；
 *                 它们的工作目录是 App 在 `Documents\Codex\<日期>\<随机短名>` 下建的，
 *                 根目录记在 `thread-workspace-root-hints`。名单偶有遗漏（实测 4 个
 *                 线程不在名单里、目录却在那个根下），所以两样都认
 *
 * @returns {{ descriptions: Map<string, string>, chats: CodexChats }}
 */
export function codexApp({ file = CODEX_STATE_FILE } = {}) {
  /** @type {CodexChats} */
  const chats = { ids: new Set(), roots: [] };
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { descriptions: new Map(), chats };
  }
  const table = state?.['electron-persisted-atom-state']?.['thread-descriptions-v1'];
  const descriptions = table && typeof table === 'object'
    ? new Map(Object.entries(table).filter(([, v]) => typeof v === 'string' && v.trim()))
    : new Map();

  const projectless = state?.['projectless-thread-ids'];
  if (Array.isArray(projectless)) for (const id of projectless) if (typeof id === 'string') chats.ids.add(id);
  const hints = state?.['thread-workspace-root-hints'];
  if (hints && typeof hints === 'object') {
    // 只取独立聊天的那几条 hint：项目线程的 hint 是项目根，当成聊天根会把整个项目吞进来
    const roots = new Set();
    for (const [id, root] of Object.entries(hints)) if (chats.ids.has(id) && text(root)) roots.add(root);
    chats.roots = [...roots];
  }
  return { descriptions, chats };
}

/** 旧接口：只要描述表。 */
export function codexDescriptions({ file = CODEX_STATE_FILE } = {}) {
  return codexApp({ file }).descriptions;
}

/** child 是 root 本身或在它下面。`+ sep` 不能省：`Codex` 不能匹配到 `Codex-other`。 */
function within(child, root) {
  const c = normPath(child);
  const r = normPath(root);
  return Boolean(c && r) && (c === r || c.startsWith(r + path.sep));
}

/** @param {string} providerId @param {string | null} cwd @param {CodexChats | undefined} chats */
export function isCodexChat(providerId, cwd, chats) {
  if (!chats) return false;
  if (chats.ids.has(providerId)) return true;
  return Boolean(cwd) && chats.roots.some((r) => within(cwd, r));
}

export const CODEX_CHATS = Object.freeze({ key: 'codex:chats', name: 'Codex 独立聊天' });
export const ANTIGRAVITY_CHATS = Object.freeze({ key: 'antigravity:chats', name: 'Antigravity 独立聊天' });

function folder(dir) {
  const trimmed = String(dir).replace(/[\\/]+$/, '');
  // 手写而不用 path.basename：cwd 是 provider 记下的字符串，可能用任一种分隔符
  return {
    key: normPath(trimmed),
    name: trimmed.split(/[\\/]/).pop() || trimmed,
    /*
      这一组的目录本身，原样大小写。侧栏组头上那颗「在这里开新会话」要用（2026-11-11）：
      key 是小写过的，worktree 会话自己的 cwd 又是 worktree 而不是项目根，两个都不能直接当新会话的 cwd
    */
    dir: path.resolve(trimmed),
  };
}

/**
 * 这个会话在列表里归哪一组——和 App 侧栏归在同一个地方。
 *
 *   Claude       注册表里有：App 的 `originCwd || cwd`（worktree 会话归原仓库）；
 *                旧段跟它所属的那条；不在 App 里的（终端开的）按 cwd
 *   Codex        独立聊天归一组；其余按 cwd（实测 23 个项目线程的 cwd 都正好是项目根）
 *   Antigravity  conversation_summaries.db 的 workspace_uris 优先；outside-of-project 归独立聊天
 *
 * `key` 只用来归组和记折叠状态，`name` 是组头上的字。会话自己的 `cwd` 不动：
 * 上传、看文件、发消息都还是在它真正跑的那个目录里。
 *
 * @returns {{ key: string, name: string, dir?: string } | null}
 */
export function resolveProject({ agent, providerId, cwd, app, chats, antigravity }) {
  if (agent === 'codex' && isCodexChat(providerId, cwd, chats)) return { ...CODEX_CHATS };
  if (agent === 'antigravity') {
    const s = antigravity?.get(providerId);
    const dir = s?.cwd ?? cwd;
    if (s?.projectId === 'outside-of-project' || !dir) return { ...ANTIGRAVITY_CHATS };
    return folder(dir);
  }
  const own = agent === 'claude'
    ? (app?.sessions?.get(providerId) ?? app?.lineage?.get(providerId))
    : null;
  const dir = own?.project ?? cwd;
  return dir ? folder(dir) : null;
}

/**
 * 从第一条消息派生标题。
 *
 * **先切掉末尾那段附件清单再收空白**，顺序不能反：`replace(/\s+/g,' ')` 会把
 * 换行压没，而那段清单正是靠 `

抬头
` 认出来的。不切的话，侧栏和页头会
 * 显示成「只回复两个字：收到 附件（已放在工作目录下）： - .baton-uploads/…」。
 *
 * 只发文件、一个字没写的那种消息（现在允许了），切完正文是空的——这时用文件名
 * 当标题，比退回「目录 · 日期」有用得多。
 */
function clip(raw) {
  const { body, files } = stripAttachmentList(raw);
  let one = body.replace(/\s+/g, ' ').trim();
  if (!one && files.length) {
    one = files.length === 1 ? files[0] : `${files[0]} 等 ${files.length} 个文件`;
  }
  return one.length > MAX_DERIVED ? `${one.slice(0, MAX_DERIVED)}…` : one;
}

function fallback(cwd, firstTs) {
  // 手写而不用 path.basename：cwd 是 provider 记下的字符串，可能用任一种分隔符
  const base = cwd ? (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '未知目录') : '未知目录';
  const day = firstTs ? String(firstTs).slice(0, 10) : '未知日期';
  return `${base} · ${day}`;
}

/**
 * 标题：**App 里显示什么，这里就显示什么。**
 *
 *   Claude  1  注册表（App 侧栏那一行；旧段用接替它的那条）
 *           1  不在 App 里的按 CLI `/resume` 选单顺序：
 *              agent-name → custom-title → ai-title
 *           2  首句
 *   Codex   1  线程名（session_index.jsonl）→ 描述表（老版本兜底）
 *           2  首句（App 这时显示的 preview 也是它）
 *   两边    3  什么都没有：目录名 · 日期
 *
 * `titleTier` 透给客户端：1 = 这个名字是 App / CLI 里确实存在的那个；2、3 = Baton
 * 推导的，客户端会淡化显示。
 */
export function resolveTitle({
  agent, providerId, registry, lineage, descriptions, names, antigravity,
  agentName, customTitle, aiTitle, firstUserText, cwd, firstTs,
}) {
  if (agent === 'codex') {
    const named = names?.get(providerId) ?? descriptions?.get(providerId);
    if (named) return { title: named, titleTier: 1 };
  } else if (agent === 'antigravity') {
    const named = antigravity?.get(providerId)?.title;
    if (named) return { title: named, titleTier: 1 };
  } else {
    const r = registry?.get(providerId) ?? lineage?.get(providerId);
    if (r?.title) return { title: r.title, titleTier: 1 };
    // CLI 用的是 `||`：空字符串往下落
    const named = agentName || customTitle || aiTitle;
    if (named) return { title: named, titleTier: 1 };
  }
  if (firstUserText) return { title: clip(firstUserText), titleTier: 2 };
  return { title: fallback(cwd, firstTs), titleTier: 3 };
}
