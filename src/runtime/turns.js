import fs from 'node:fs';
import path from 'node:path';
import { BATON_DIR } from '../config.js';
import { emitTurn } from './bus.js';
import { currentInstanceId, executionHandle } from './instance.js';
import { processBirth } from './processIdentity.js';
import { preserveReceipt, withReceipt } from './receipts.js';

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
  if (status === 'unconfirmed') return 'unconfirmed';
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
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
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
 *   实例启动时恢复仍有执行证据的轮次，并在最后一个运行中的轮次结算后摘掉会话。
 */
const running = new Set();
// turnId -> 当前执行句柄。桌面桥接仅可监控，其余执行由句柄请求停止。
export const liveTurns = new Map();

export function registerTurnHandle(key, turnId, handle) {
  liveTurns.set(turnId, handle);
  const recordPid = (pid, birth = null) => updateTurnControl(key, turnId, { childPid: pid,
    ...(birth ? { childStarted: birth } : {}), ...(handle.detachedGroup ? { childGroup: pid } : {}) });
  if (handle.canStop === false) updateTurnControl(key, turnId, { canStop: false, ...(handle.monitor ? { monitor: handle.monitor } : {}) });
  else if (handle.onPid) handle.onPid(recordPid);
  else if (Number.isInteger(handle.pid) && handle.pid > 0) recordPid(handle.pid, handle.childStarted);
  executionHandle(turnId, handle, () => {
    if (!read(BATON_DIR, key, turnId)?.stopReason) updateTurnControl(key, turnId, { stopReason: 'Baton 守护进程正在关闭，已请求停止本轮。' });
  }, true);
}

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
export function startTurn({ key, turnId, agent, prompt, request = null, queueId = null, principalId = null, principalGeneration = null,
  adoptedDesktop = null },
  { dir = BATON_DIR, now = Date.now(), beforePublish = null } = {}) {
  const turn = {
    key, turnId, agent, status: 'running',
    ...(currentInstanceId() ? { ownerId: currentInstanceId(), ownerPid: process.pid } : {}),
    ...(adoptedDesktop ? { canStop: false, ownerId: adoptedDesktop.ownerId, monitor: adoptedDesktop.monitor } : {}),
    startedAt: now, endedAt: null, error: null, tokens: null, eventCount: 0,
    ...(typeof prompt === 'string' && prompt ? { prompt } : {}),
    ...(request ? { request } : {}),
    ...(queueId ? { queueId } : {}),
    ...(principalId ? { principalId } : {}),
    ...(principalGeneration ? { principalGeneration } : {}),
  };
  withReceipt(turn, () => {
    write(dir, key, turn);
    try { beforePublish?.(); } catch (error) {
      fs.unlinkSync(turnFile(key, turnId, { dir }));
      throw error;
    }
  }, { dir, now, allowSourceOnly: !!queueId, durableSource: true });
  running.add(key);
  emitTurn(key, 'turn_start', turn);
  return turn;
}

// 停止请求是运行中的一个标志。进程退出前，普通发送、插队和队列看门狗都仍看到 running。
export function updateTurnControl(key, turnId, fields, { dir = BATON_DIR } = {}) {
  const turn = read(dir, key, turnId);
  if (!turn || turn.status !== 'running') return turn;
  const updated = write(dir, key, { ...turn, ...fields });
  emitTurn(key, 'turn_control', updated);
  return updated;
}

const TERMINAL = new Set(['ok', 'failed', 'anomaly', 'aborted', 'handoff', 'unconfirmed']);
const MAX_TURNS_PER_SESSION = 50;

function pruneTurns(dir, key, keep, turns, now) {
  if (!Number.isFinite(keep) || keep < 1) return;
  const finished = turns.filter((t) => TERMINAL.has(t.status));
  const excess = finished.length - keep;
  if (excess <= 0) return;
  for (const old of finished.slice(0, excess)) {
    try {
      preserveReceipt(old, { dir, now });
      fs.unlinkSync(turnFile(key, old.turnId, { dir }));
    } catch {
      // 无法保存回执或清理记录时保留原件，后续收尾再试。
    }
  }
}

export function endTurn(
  { key, turnId, status, error, tokens, eventCount },
  { dir = BATON_DIR, now = Date.now(), keep = MAX_TURNS_PER_SESSION } = {},
) {
  const prev = read(dir, key, turnId) ?? { key, turnId, agent: null, startedAt: now };
  // 终态是终态：已经结束的一轮不得被改写。
  // 重复的收尾只返回第一次的结果，客户端只收到一帧 turn_end。
  if (TERMINAL.has(prev.status)) return prev;
  const outcome = prev.stopReason ? 'aborted' : classifyOutcome({ status, eventCount });
  const explain = outcome === 'anomaly'
    ? `本轮有 ${tokenTotal(tokens)} 个 token 产出但没有产生任何消息事件。`
      + '通常意味着 agent 被中途杀掉、输出 schema 变了，或写入 transcript 失败。'
      + '检查 docs/ops/agent-protocol.md 与该会话 transcript 的尾部。'
    : (prev.stopReason ?? error ?? null);
  const turn = write(dir, key, {
    ...prev,
    status: outcome,
    endedAt: now,
    error: explain,
    tokens: tokens ?? null,
    eventCount: eventCount ?? 0,
  });
  const records = listTurns(key, { dir });
  if (!records.some((record) => record.status === 'running')) running.delete(key);
  emitTurn(key, 'turn_end', turn);
  pruneTurns(dir, key, keep, records, now);
  return turn;
}

export function listTurns(key, { dir = BATON_DIR } = {}) {
  let names;
  try {
    names = fs.readdirSync(runsDir(dir, key)).filter((n) => n.endsWith('.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .map((n) => read(dir, key, n.replace(/\.json$/, '')))
    .filter(Boolean)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function latestTurn(key, opts) {
  const turns = listTurns(key, opts);
  return turns.findLast((turn) => turn.status === 'running') ?? turns.at(-1) ?? null;
}

const INTERRUPTED = '这一轮还没跑完，Baton 守护进程就退出了（重启、崩溃或关机）。';

export function ownedProcessAlive(pid, turn, { platform = process.platform, probe = process.kill.bind(process), birthOf = processBirth } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const exists = (target) => {
    try { probe(target, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  };
  if (exists(pid)) {
    if (!turn?.childStarted) return true; // 旧记录缺少创建时间，只保守观察，绝不按此 PID 发停止信号。
    const birth = birthOf(pid);
    return !birth || birth === turn.childStarted;
  }
  return platform !== 'win32' && turn?.childGroup === pid && exists(-pid);
}

export function recoverTurn(turn, { dir = BATON_DIR, now = Date.now(), alive = ownedProcessAlive, inspectMonitor = (_turn) => null } = {}) {
  if (turn.ownerId && turn.ownerId === currentInstanceId()) return null;
  const observed = turn.canStop === false ? inspectMonitor(turn) : null;
  if (turn.canStop === false ? !observed : turn.childPid && alive(turn.childPid, turn)) {
    running.add(turn.key);
    return null;
  }
  return endTurn({ key: turn.key, turnId: turn.turnId, status: 'failed', error: INTERRUPTED,
    tokens: turn.tokens, eventCount: turn.eventCount, ...observed }, { dir, now });
}

/**
 * 新实例取得目录的独占锁后再检查上一实例留下的轮次。活着的子进程和桌面端
 * 仍在处理的请求继续占有会话；调用方定期复查，直到能确认其终态。
 */
export function reconcileRunning({ dir = BATON_DIR, key: onlyKey = null, now = Date.now(), alive = ownedProcessAlive,
  inspectMonitor = (_turn) => null, onRetained = (_turn) => {}, onScanError = (_key) => {} } = {}) {
  let names;
  try {
    names = onlyKey == null ? fs.readdirSync(path.join(dir, 'runs')) : [encodeURIComponent(onlyKey)];
  } catch (error) {
    if (error.code !== 'ENOENT') onScanError(null);
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
    let records;
    try { records = listTurns(key, { dir }); } catch { onScanError(key); continue; }
    for (const t of records) {
      if (t.status !== 'running') continue;
      let ended;
      try { ended = recoverTurn(t, { dir, now, alive, inspectMonitor }); } catch { running.add(key); }
      if (ended) fixed.push(ended);
      else onRetained(t);
    }
  }
  return fixed;
}
