import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTurn, endTurn, listTurns, latestTurn, classifyOutcome } from '../src/runtime/turns.js';
import { tmpDir } from './helpers.js';

const KEY = 'claude:YWJj';

test('classifyOutcome：有 token 却零消息判为异常', () => {
  assert.equal(classifyOutcome({ status: 'ok', tokens: { output_tokens: 512 }, eventCount: 0 }), 'anomaly');
});

test('classifyOutcome：正常成功与明确失败', () => {
  assert.equal(classifyOutcome({ status: 'ok', tokens: { output_tokens: 512 }, eventCount: 3 }), 'ok');
  assert.equal(classifyOutcome({ status: 'failed', tokens: null, eventCount: 0 }), 'failed');
  assert.equal(classifyOutcome({ status: 'ok', tokens: null, eventCount: 0 }), 'anomaly',
    '既无 token 又无消息，同样不是正常成功');
});

test('classifyOutcome：aborted 是显式终态，不被零消息改判为异常', () => {
  assert.equal(classifyOutcome({ status: 'aborted', tokens: null, eventCount: 0 }), 'aborted');
});

test('startTurn 落盘为 running 状态', () => {
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't1', agent: 'claude' }, { dir, now: 1000 });
  const t = latestTurn(KEY, { dir });
  assert.equal(t.status, 'running');
  assert.equal(t.startedAt, 1000);
  assert.equal(t.endedAt, null);
});

test('endTurn 写入终态、错误与 token', () => {
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't1', agent: 'codex' }, { dir, now: 1000 });
  const t = endTurn({
    key: KEY, turnId: 't1', status: 'failed',
    error: 'stream disconnected before completion', tokens: { output_tokens: 12 }, eventCount: 2,
  }, { dir, now: 2000 });
  assert.equal(t.status, 'failed');
  assert.equal(t.endedAt, 2000);
  assert.match(t.error, /stream disconnected/);
  assert.equal(t.tokens.output_tokens, 12);
});

test('endTurn 会把「有 token 零消息」改判为 anomaly 并给排查方向', () => {
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't2', agent: 'claude' }, { dir, now: 1 });
  const t = endTurn({ key: KEY, turnId: 't2', status: 'ok', tokens: { output_tokens: 900 }, eventCount: 0 }, { dir, now: 2 });
  assert.equal(t.status, 'anomaly');
  assert.ok(t.error, '异常必须带说明，否则用户不知道发生了什么');
  assert.match(t.error, /900/, '说明里要带上实际的 token 数');
});

test('listTurns 按开始时间升序，未知 key 返回空数组', () => {
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 'b', agent: 'claude' }, { dir, now: 200 });
  startTurn({ key: KEY, turnId: 'a', agent: 'claude' }, { dir, now: 100 });
  assert.deepEqual(listTurns(KEY, { dir }).map((t) => t.turnId), ['a', 'b']);
  assert.deepEqual(listTurns('claude:bm9wZQ', { dir }), []);
});

test('每一轮都留下记录，即使进程崩溃没走到 endTurn', () => {
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't3', agent: 'claude' }, { dir, now: 1 });
  const t = latestTurn(KEY, { dir });
  assert.equal(t.status, 'running', '重连时能看到它还挂着，而不是无迹可寻');
});

test('key 含 base64url 字符时也能安全落盘', () => {
  const dir = tmpDir();
  const weird = 'codex:MjAyNi8wOS8xMC9yb2xsb3V0LTIwMjY_Lmpzb25s';
  startTurn({ key: weird, turnId: 't1', agent: 'codex' }, { dir, now: 1 });
  assert.equal(latestTurn(weird, { dir }).turnId, 't1');
});

// ── 守护进程重启后收尾 ─────────────────────────────

import { reconcileRunning } from '../src/runtime/turns.js';
import { writeIntent, reconcileOrphans } from '../src/runtime/intents.js';

test('reconcileRunning：上一个守护进程留下的 running 一律收成 failed，并说明原因', () => {
  // 09-22 的真实形态：一轮跑到一半守护进程没了，没有停止意图。
  // 记录永远停在 running，于是之后每条消息都排在一个不存在的轮次后面。
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't1', agent: 'claude' }, { dir, now: 1 });
  const fixed = reconcileRunning({ dir, now: 9 });
  assert.equal(fixed.length, 1);
  const t = latestTurn(KEY, { dir });
  assert.equal(t.status, 'failed');
  assert.equal(t.endedAt, 9);
  assert.match(t.error, /守护进程/, '要说清为什么没跑完');
});

test('reconcileRunning：已结束的轮次不动，别的会话也照样收', () => {
  const dir = tmpDir();
  const OTHER = 'codex:ZGVm';
  startTurn({ key: KEY, turnId: 'done', agent: 'claude' }, { dir, now: 1 });
  endTurn({ key: KEY, turnId: 'done', status: 'ok', tokens: null, eventCount: 3 }, { dir, now: 2 });
  startTurn({ key: OTHER, turnId: 'stale', agent: 'codex' }, { dir, now: 3 });
  const fixed = reconcileRunning({ dir, now: 9 });
  assert.deepEqual(fixed.map((t) => t.turnId), ['stale']);
  assert.equal(latestTurn(KEY, { dir }).status, 'ok');
  assert.equal(latestTurn(KEY, { dir }).endedAt, 2);
  assert.equal(latestTurn(OTHER, { dir }).status, 'failed');
});

test('reconcileRunning：有停止意图的先按「已停止」收，不被改写成失败', () => {
  // 两个收尾的先后：用户确实按过停止的，应当显示「已停止」
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't1', agent: 'claude' }, { dir, now: 1 });
  writeIntent({ key: KEY, type: 'stop', turnId: 't1' }, { dir, now: 2 });
  reconcileOrphans({ dir, isAlive: () => false, now: 3 });
  assert.deepEqual(reconcileRunning({ dir, now: 4 }), []);
  assert.equal(latestTurn(KEY, { dir }).status, 'aborted');
});

test('reconcileRunning：还没有 runs 目录时什么都不做', () => {
  assert.deepEqual(reconcileRunning({ dir: tmpDir() }), []);
});

test('endTurn 超过 keep 上限时清理最老的已结束轮次，但保留 running 轮次', () => {
  const dir = tmpDir();
  for (let i = 1; i <= 5; i += 1) {
    startTurn({ key: KEY, turnId: `t${i}`, agent: 'claude' }, { dir, now: i * 10 });
    endTurn({ key: KEY, turnId: `t${i}`, status: 'ok', tokens: null, eventCount: 1 }, { dir, now: i * 10 + 1, keep: 3 });
  }
  const kept = listTurns(KEY, { dir }).map((t) => t.turnId);
  assert.deepEqual(kept, ['t3', 't4', 't5']);
});
