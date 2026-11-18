import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { antigravityApp, GEMINI_ROOT } from '../antigravity.js';

/**
 * 电脑上正在跑的会话。
 *
 * owner 2026-10-08：「我刚刚下班，打开手机，就看不到哪些会话是还在工作的」。
 * Baton 原来只认自己起的那一轮（runtime/turns.js 里那个内存集合）——在桌面 App
 * 或终端里起的轮次，手机上看着和闲着一模一样。
 *
 * 信号用 CLI 自己的那份进程登记：`~/.claude/sessions/<pid>.json`，每个活着的
 * CLI 进程一个文件，里面有 `sessionId`、`status`、`waitingFor`。实测依据与
 * 各字段含义见 `docs/ops/agent-protocol.md` §11，关键的几条：
 *
 *   进程起来就有、退了就没   起一个真的 `claude -p`，4 秒后目录里多一个文件，
 *                            进程一退文件就消失
 *   busy 是真的在跑          三条报 busy 的会话，transcript 都在几十秒内写过
 *   waiting 是在等人         CLI 登记状态如 `status: "waiting", waitingFor: "input needed"`
 *   一个会话可能有两个进程   宿主那个报 idle、真正干活的子进程报 busy
 *
 * **只有 Claude 有这个东西。** Codex 的 app-server 是一个进程管所有线程，
 * `thread-writer-locks` 下的锁实测是三小时前的陈货（那条线程早停了），
 * 所以 Codex 仍然只认 Baton 自己起的轮次。这是已知差距，不拿近似值糊弄。
 */

export const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

/** busy 压过 waiting：一个会话同时有这两种进程时，它确实在跑。 */
const RANK = { waiting: 1, busy: 2 };

/**
 * 这个 pid 还在不在。
 *
 * `kill(pid, 0)` 不发信号，只做存在性检查。EPERM = 进程在、但不归我管——
 * 那也是**活着**，不能当成没了（Windows 上系统进程常是这样）。
 *
 * @param {unknown} pid
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return (/** @type {any} */ (err))?.code === 'EPERM';
  }
}

/**
 * 读那个目录，产出「会话 id → 'busy' | 'waiting'」。闲着的不进表。
 * 同时读 Antigravity 的 `conversation_summaries.db`（受 30 分钟内更新窗口约束，防崩溃脏状态）。
 *
 * 代价是一次 readdir 加几个几百字节的 JSON（实测 6 个文件），不是按会话逐个读盘，
 * 所以列表每次都现读，不缓存——缓存了反而会让「刚点开手机」那一眼是旧的。
 *
 * @param {{ dir?: string, geminiRoot?: string | null, alive?: (pid: unknown) => boolean, now?: number }} [opts]
 * @returns {Map<string, 'busy' | 'waiting'>}
 */
export function liveStates(opts = {}) {
  const { dir = CLAUDE_SESSIONS_DIR, alive = pidAlive, now = Date.now() } = opts;
  const geminiRoot = 'geminiRoot' in opts ? opts.geminiRoot : (!('dir' in opts) ? GEMINI_ROOT : null);
  /** @type {Map<string, 'busy' | 'waiting'>} */
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = []; // 没装 Claude、或者一个会话都没开过
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // 写到一半的、坏的，跳过
    }
    const state = raw?.status === 'busy' ? 'busy' : raw?.status === 'waiting' ? 'waiting' : null;
    if (!state) continue;
    // 没有 pid 就没法判断它还在不在，这种文件一律不信。不把这条交给 alive：
    // 那是个可注入的开关，而「文件缺字段」是文件自己的问题
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) continue;
    if (!alive(raw.pid)) continue;
    for (const id of idsOf(raw)) {
      const had = out.get(id);
      if (!had || RANK[state] > RANK[had]) out.set(id, state);
    }
  }
  if (geminiRoot) {
    const { summaries } = antigravityApp({ root: geminiRoot });
    for (const [id, s] of summaries) {
      if (s.nestingDepth > 0 || s.killed) continue;
      if (s.lastModifiedMs && now - s.lastModifiedMs > 30 * 60_000) continue;
      const state = s.status === 'CASCADE_RUN_STATUS_RUNNING'
        ? 'busy'
        : (s.status && /WAITING/i.test(s.status) ? 'waiting' : null);
      if (!state) continue;
      const had = out.get(id);
      if (!had || RANK[state] > RANK[had]) out.set(id, state);
    }
  }
  return out;
}

/**
 * 这个进程对得上哪些会话身份。
 *
 * 两个都要：`sessionId` 是**当前这段** transcript 的 id，而压缩上下文之后 CLI 会换
 * 新 id；`hostSessionId` 是桌面 App 注册项（`local_<cliSessionId>`），也就是 Baton
 * 列表上那条的身份。只认一个就会在「压缩过的会话」上漏掉（§9.1）。
 */
function idsOf(raw) {
  const out = [];
  if (typeof raw.sessionId === 'string' && raw.sessionId) out.push(raw.sessionId);
  if (typeof raw.hostSessionId === 'string' && raw.hostSessionId.startsWith('local_')) {
    out.push(raw.hostSessionId.slice('local_'.length));
  }
  return out;
}
