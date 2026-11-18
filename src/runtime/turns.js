import fs from 'node:fs';
import path from 'node:path';
import { BATON_DIR } from '../config.js';
import { emitTurn } from './bus.js';

// 每一轮都有终态记录。这是五个现有工具共同的致命伤：
// 轮次结束得不明不白，客户端就只能永远转圈。

const runsDir = (dir, key) => path.join(dir, 'runs', encodeURIComponent(key));

export function turnFile(key, turnId, { dir = BATON_DIR } = {}) {
  return path.join(runsDir(dir, key), `${turnId}.json`);
}

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  return Object.values(tokens).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
}

export function classifyOutcome({ status, eventCount }) {
  // aborted 是用户主动停止的显式终态，不参与「零消息即异常」的判定
  if (status === 'aborted') return 'aborted';
  if (status === 'failed') return 'failed';
  // 交给了正开着这个会话的 Codex App 去跑（agent/codexQueue.js）。这一轮在 Baton 这边没有消息，
  // 但不是异常：回复由 App 写进同一个 rollout
  if (status === 'handoff') return 'handoff';
  // 零消息即异常：有 token 产出却一条消息都没有是故障，
  // 既无 token 又无消息同样不是正常成功（spec §12）
  if ((eventCount ?? 0) === 0) return 'anomaly';
  return 'ok';
}

function write(dir, key, turn) {
  fs.mkdirSync(runsDir(dir, key), { recursive: true });
  const file = turnFile(key, turn.turnId, { dir });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(turn, null, 1));
  fs.renameSync(tmp, file);
  return turn;
}

function read(dir, key, turnId) {
  try {
    return JSON.parse(fs.readFileSync(turnFile(key, turnId, { dir }), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 当前有轮次在跑的会话，内存集合。
 *
 * 列表页每行左边那颗圆点靠它——珊瑚色呼吸 = 在跑，那是列表里**唯一**的状态表达
 * （一行只有圆点和标题，没有任何状态文字）。
 *
 * 为什么不去读轮次记录：
 *   贵——每个会话都要 readdir + 读全部轮次文件，实测 163 条链，一次列表请求
 *        就是上百次 IO。
 *   而且**内存这份更准**：守护进程如果在某一轮跑到一半时挂掉，那条记录的
 *        status 会永远停在 running（reconcileOrphans 只收有停止意图的那些）。
 *        内存集合重启即空，正好对应「那个进程确实已经不在了」。
 */
const running = new Set();

export function runningKeys() {
  return running;
}

/**
 * `prompt` = 这一轮发出去的那句话，原样。
 *
 * 2026-11-10 owner：「消息点击发送后，先出现正在思考的那个动画，但是我的消息并没有出现在
 * 消息会话窗口中，而是过了一会才显示，并且跳到那个动画上方」。消息要等 agent 进程起来、
 * 自己写进 transcript 才有——好几秒；`turn_start` 却是当场到的。带上原文，客户端收到
 * `turn_start` 就能先把这句摆出来，等 transcript 里那条到了再换成真的。
 *
 * 放在轮次记录里而不是只在发送那台设备上本地回显：另一台设备看着同一个会话时也一样
 * 先看到动画后看到消息；断线重连补推当前轮次时也带着它。
 */
export function startTurn({ key, turnId, agent, prompt }, { dir = BATON_DIR, now = Date.now() } = {}) {
  running.add(key);
  const turn = write(dir, key, {
    key, turnId, agent, status: 'running',
    startedAt: now, endedAt: null, error: null, tokens: null, eventCount: 0,
    ...(typeof prompt === 'string' && prompt ? { prompt } : {}),
  });
  emitTurn(key, 'turn_start', turn);
  return turn;
}

const TERMINAL = new Set(['ok', 'failed', 'anomaly', 'aborted', 'handoff']);
const MAX_TURNS_PER_SESSION = 50;

function pruneTurns(dir, key, keep) {
  if (!Number.isFinite(keep) || keep < 1) return;
  const turns = listTurns(key, { dir });
  const finished = turns.filter((t) => TERMINAL.has(t.status));
  const excess = finished.length - keep;
  if (excess <= 0) return;
  for (const old of finished.slice(0, excess)) {
    try {
      fs.unlinkSync(turnFile(key, old.turnId, { dir }));
    } catch {
      // already removed
    }
  }
}

export function endTurn(
  { key, turnId, status, error, tokens, eventCount },
  { dir = BATON_DIR, now = Date.now(), keep = MAX_TURNS_PER_SESSION } = {},
) {
  const prev = read(dir, key, turnId) ?? { key, turnId, agent: null, startedAt: now };
  // 终态是终态：已经结束的一轮不得被改写。
  // 用户点了停止之后，进程自己的 .then() 仍会跑一遍 endTurn——
  // 若不拦住，「已停止」会被覆盖成「正常完成」，停止就失去了痕迹。
  // 没有状态变化就不发事件：否则停止后进程自己的 .then() 会让客户端收到第二个
  // turn_end，秒表当场跳一下。
  if (TERMINAL.has(prev.status)) return prev;
  const outcome = classifyOutcome({ status, eventCount });
  const explain = outcome === 'anomaly'
    ? `本轮有 ${tokenTotal(tokens)} 个 token 产出但没有产生任何消息事件。`
      + '通常意味着 agent 被中途杀掉、输出 schema 变了，或写入 transcript 失败。'
      + '检查 docs/ops/agent-protocol.md 与该会话 transcript 的尾部。'
    : (error ?? null);
  running.delete(key);
  const turn = write(dir, key, {
    ...prev,
    status: outcome,
    endedAt: now,
    error: explain,
    tokens: tokens ?? null,
    eventCount: eventCount ?? 0,
  });
  emitTurn(key, 'turn_end', turn);
  pruneTurns(dir, key, keep);
  return turn;
}

export function listTurns(key, { dir = BATON_DIR } = {}) {
  let names;
  try {
    names = fs.readdirSync(runsDir(dir, key)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((n) => read(dir, key, n.replace(/\.json$/, '')))
    .filter(Boolean)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function latestTurn(key, opts) {
  return listTurns(key, opts).at(-1) ?? null;
}

const INTERRUPTED = '这一轮还没跑完，Baton 守护进程就退出了（重启、崩溃或关机）。';

/**
 * 守护进程启动时调用：盘上还是 running 的轮次，一律收尾。
 *
 * 终态只由起这一轮的那个守护进程写（sendMessage 里 runner 的 .then）。那个进程
 * 一没，就再也没有人会写了——而 reconcileOrphans 只收有停止意图的那些。
 * 09-22 就是这样留下一条永远 running 的记录：之后八天里，那个会话的秒表一直
 * 走（显示 11721:44），每条新消息都排在这个不存在的轮次后面，永远发不出去。
 *
 * 能一律收，依据和上面 `running` 那段是同一条：它在内存里，重启即空。刚启动的
 * 进程手里一个轮次都没有，所以盘上所有 running 都是上一个进程的。
 *
 * 前提是**确实只有这一个守护进程**。所以调用方必须在端口绑定成功之后才调它
 * （见 cli.js）：不小心再起一个的话，第二个绑不上端口就会退出，不会把第一个
 * 正在跑的轮次收掉。
 *
 * 判 failed 而不是 aborted：aborted 是「用户按了停止」，这里没人按。
 * 有停止意图的那些先由 reconcileOrphans 收成 aborted，这里的终态守卫不会改写它们。
 */
export function reconcileRunning({ dir = BATON_DIR, now = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, 'runs'));
  } catch {
    return [];
  }
  const fixed = [];
  for (const name of names) {
    let key;
    try {
      key = decodeURIComponent(name);
    } catch {
      continue; // 不是本模块写的目录名
    }
    for (const t of listTurns(key, { dir })) {
      if (t.status !== 'running') continue;
      fixed.push(endTurn({
        key, turnId: t.turnId, status: 'failed', error: INTERRUPTED,
        tokens: t.tokens, eventCount: t.eventCount,
      }, { dir, now }));
    }
  }
  return fixed;
}
