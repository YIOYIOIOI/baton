import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BATON_DIR } from '../config.js';
import { emitTurn } from '../runtime/bus.js';
import { ASK_TIMEOUT_MS, ASK_TIMEOUT_TEXT, ASK_CANCELLED_TEXT, formatAnswer } from './protocol.js';

/**
 * 待答问题。**一个会话同时只有一个**——agent 是一轮一进程、串行提问，
 * 队列在这里没有意义，而「屏幕上同时挂两张问题卡」只会让人不知道该答哪个。
 *
 * ## 为什么要落盘
 *
 * CLAUDE.md 第三条：「不要把运行态只放内存。手机断连是常态不是异常」。
 * 问题挂起期间用户很可能正好切走、锁屏、换网。重新连上来的那一刻，客户端
 * 必须能问出「现在有没有人在等我回答」，而不是等下一次状态变化。
 *
 * 盘上那份是**镜像不是真相**：真相是那个还挂着的 HTTP 响应（MCP 服务器在
 * 另一头等着）。守护进程一重启，挂着的响应就断了，盘上那份即作废——
 * 所以启动时要清（见 reconcileAsks）。
 */

const asksDir = (dir) => path.join(dir, 'asks');
const askFile = (dir, key) => path.join(asksDir(dir), `${encodeURIComponent(key)}.json`);

/** key -> { ask, resolve, timer } */
const pending = new Map();
/** 一次性令牌 -> { key, turnId }。只活在内存里：它的寿命就是这一轮进程的寿命。 */
const tokens = new Map();

function mirror(dir, key, ask) {
  try {
    fs.mkdirSync(asksDir(dir), { recursive: true });
    const file = askFile(dir, key);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ask, null, 1));
    fs.renameSync(tmp, file);
  } catch {
    // 盘写不进去不该让这一轮失败——内存那份仍然可用，只是重连补不上
  }
}

function unmirror(dir, key) {
  try {
    fs.rmSync(askFile(dir, key), { force: true });
  } catch {
    // 同上
  }
}

/**
 * 给这一轮铸一个令牌。MCP 服务器拿它回连，守护进程据此知道
 * 「这是哪个会话、哪一轮在问」——**不从请求体里读**，读了 agent 就能自报
 * 别人的会话，把问题推到别人手机上。
 */
export function mintAskToken({ key, turnId }) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { key, turnId });
  return token;
}

export function resolveAskToken(token) {
  return (typeof token === 'string' && tokens.get(token)) || null;
}

export function revokeAskToken(token) {
  tokens.delete(token);
}

/**
 * 开一个问题，返回一个**等人回答的 promise**。
 *
 * 调用方（HTTP 处理器）把响应挂在这个 promise 上，于是 MCP 服务器那条请求
 * 一直不返回，于是 agent 那一轮一直停在工具调用上——这正是我们要的
 * 「在这一轮里等你选」。
 */
export function openAsk({
  key, turnId, question, options, multiSelect, header,
}, { dir = BATON_DIR, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  // 同一个会话再来一个问题：上一个作废。不可能有两个同时有效的——
  // 一轮一进程，前一个还挂着就说明那个进程已经没了。
  cancelAsk(key, ASK_CANCELLED_TEXT, { dir });

  const ask = {
    askId: crypto.randomUUID(),
    key,
    turnId,
    question,
    options,
    multiSelect: multiSelect === true,
    header: header ?? null,
    openedAt: Date.now(),
    expiresAt: Date.now() + timeoutMs,
  };

  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });

  const timer = setTimeout(() => {
    finish(key, ASK_TIMEOUT_TEXT, { dir, reason: 'timeout' });
  }, timeoutMs);
  timer.unref?.();

  pending.set(key, { ask, settle, timer });
  mirror(dir, key, ask);
  emitTurn(key, 'ask', ask);
  return { ask, promise };
}

function finish(key, textForAgent, { dir = BATON_DIR, reason = 'answered' } = {}) {
  const entry = pending.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(key);
  unmirror(dir, key);
  emitTurn(key, 'ask_end', { askId: entry.ask.askId, key, reason });
  entry.settle(textForAgent);
  return true;
}

/**
 * 回答。`picked` 是选中的 label 列表，`free` 是自己写的那一段。
 *
 * 两者可以同时有：实测 Claude 自己那个问题工具的 165 条结果里，用户经常
 * 既不选给定项、也不是完全另起——而「只能二选一」会逼人把话说错。
 */
export function answerAsk({ key, askId, picked, free }, { dir = BATON_DIR } = {}) {
  const entry = pending.get(key);
  if (!entry) return { ok: false, reason: 'no_pending' };
  // askId 对不上说明客户端手上是一张过期的卡（断线期间这轮已经超时又开了新的）。
  // 宁可让它刷新，也不要把答案安到另一个问题上。
  if (askId && askId !== entry.ask.askId) return { ok: false, reason: 'stale' };

  const labels = new Set(entry.ask.options.map((o) => o.label));
  const chosen = (Array.isArray(picked) ? picked : []).filter((l) => labels.has(l));
  const written = typeof free === 'string' && free.trim() ? free.trim() : null;
  if (!chosen.length && !written) return { ok: false, reason: 'empty_answer' };
  if (!entry.ask.multiSelect && chosen.length > 1) return { ok: false, reason: 'single_only' };

  finish(key, formatAnswer({ question: entry.ask.question, picked: chosen, free: written }), {
    dir, reason: 'answered',
  });
  return { ok: true, picked: chosen, free: written };
}

/** 这一轮没了（停止 / 进程退出 / 连接断开）。agent 那边拿到作废说明。 */
export function cancelAsk(key, textForAgent = ASK_CANCELLED_TEXT, { dir = BATON_DIR } = {}) {
  return finish(key, textForAgent, { dir, reason: 'cancelled' });
}

/** 现在有没有人在等这个会话回答。重连时客户端靠它补上那张卡。 */
export function pendingAsk(key) {
  return pending.get(key)?.ask ?? null;
}

/**
 * 启动时清理盘上的残留。
 *
 * 盘上那份只是镜像——真相是挂着的 HTTP 响应，而守护进程重启之后它必然已经
 * 断了。留着的话客户端会在列表里看到一张永远点不动的问题卡。
 * 与 reconcileOrphans 同一条纪律。
 */
export function reconcileAsks({ dir = BATON_DIR } = {}) {
  let names;
  try {
    names = fs.readdirSync(asksDir(dir));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      fs.rmSync(path.join(asksDir(dir), name), { force: true });
      n += 1;
    } catch {
      // 删不掉就留着，下次再说
    }
  }
  return n;
}

// 仅供测试：确认问题结束后确实没留下定时器与条目
export function pendingCount() {
  return pending.size;
}
