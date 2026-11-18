import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { summarizeTurn, stderrReason } from '../src/agent/adapt.js';

const load = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')
  .split('\n').filter(Boolean);

test('对真实 Claude 输出判出成功、session_id 与 token', () => {
  const s = summarizeTurn('claude', load('claude-stream-json.jsonl'));
  assert.equal(s.status, 'ok');
  assert.match(s.sessionId, /^[0-9a-f-]{36}$/, '必须能从输出里取到 session_id');
  assert.ok(s.tokens && Object.values(s.tokens).some((v) => typeof v === 'number' && v > 0),
    'token 计数不得全为 0');
});

test('对真实 Codex 输出判出成功与 thread_id', () => {
  const s = summarizeTurn('codex', load('codex-exec-json.jsonl'));
  assert.equal(s.status, 'ok');
  assert.match(s.sessionId, /^[0-9a-f-]{36}$/);
  assert.ok(s.tokens.output_tokens > 0);
});

test('Codex 成功轮里的 error 记录是重连通知，不得判为失败', () => {
  // 实测：一次成功的调用里包含
  // {"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: ...)"}
  const lines = load('codex-exec-json.jsonl');
  assert.ok(lines.some((l) => JSON.parse(l).type === 'error'), '夹具里确实有 error 记录');
  assert.equal(summarizeTurn('codex', lines).status, 'ok', '终态只看 turn.completed 是否出现');
});

test('Claude 失败轮：subtype 仍是 success，只有 is_error 说了实话', () => {
  const s = summarizeTurn('claude', [JSON.stringify({
    type: 'result', subtype: 'success', is_error: true,
    result: 'Not logged in · Please run /login', session_id: 'x', usage: {},
  })]);
  assert.equal(s.status, 'failed', '拿 subtype 判成败会把失败当成功');
  assert.match(s.error, /Not logged in/);
});

test('Codex 失败轮：没有 turn.completed 就是失败，并带出最后一条 error', () => {
  const s = summarizeTurn('codex', [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'error', message: 'stream disconnected before completion' }),
  ]);
  assert.equal(s.status, 'failed');
  assert.match(s.error, /stream disconnected/);
});

test('输出里一个可识别的终态都没有时判为 failed 而非 ok', () => {
  const s = summarizeTurn('claude', [JSON.stringify({ type: 'system', subtype: 'init' })]);
  assert.equal(s.status, 'failed', '没有终态记录就是异常，不得当成功');
  assert.ok(s.error);
});

test('eventCount 数出 agent 实际产出的消息条数', () => {
  const claude = summarizeTurn('claude', load('claude-stream-json.jsonl'));
  assert.ok(claude.eventCount > 0, 'Claude 侧数 assistant 记录');
  const codex = summarizeTurn('codex', load('codex-exec-json.jsonl'));
  assert.ok(codex.eventCount > 0, 'Codex 侧数 item.completed 记录');
});

test('有 token 却零消息时 eventCount 为 0，供上层判异常', () => {
  const s = summarizeTurn('codex', [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 900 } }),
  ]);
  assert.equal(s.status, 'ok', 'adapt 层只如实汇报，异常判定在 turns 层');
  assert.equal(s.eventCount, 0);
});

test('非 JSON 噪声行被跳过而不抛异常', () => {
  const s = summarizeTurn('codex', [
    'ERROR codex_core::session: failed to load skill ...',
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 5 } }),
  ]);
  assert.equal(s.status, 'ok');
});

// 2026-11-08 owner：「我给 codex 发消息根本发不出去，baton 界面也没显示」。Codex App 开着那个会话，
// codex exec resume 拿不到写入锁当场退出，stdout 是空的——原来界面上只有「没有任何终态记录」
test('codex 一条 JSON 都没吐就退出：原因从 stderr 里取，写入锁说成人话', () => {
  const s = summarizeTurn('codex', [], 'Reading prompt from stdin...\nError: failed to acquire thread writer lock for 01a1a01d: held by another process\n');
  assert.equal(s.status, 'failed');
  assert.match(s.error, /Codex App/);
  assert.match(s.error, /没有发出去/);

  const other = summarizeTurn('codex', [], 'Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id x\n');
  assert.match(other.error, /no rollout found/, '别的原因照原文给，不再是那句空话');
  assert.ok(!/Reading prompt/.test(other.error), '噪声行要去掉');
});

test('stderr 也是空的才退回「没有终态记录」；stdout 里有 error 记录时以它为准', () => {
  assert.match(summarizeTurn('codex', [], '').error, /终态记录/);
  assert.match(summarizeTurn('claude', [], '   \n').error, /终态记录/);
  const s = summarizeTurn('codex', ['{"type":"error","message":"stream disconnected"}'], 'Error: failed to acquire thread writer lock');
  assert.equal(s.error, 'stream disconnected');
  assert.equal(stderrReason('(node:1) [DEP0190] DeprecationWarning: x\n(Use `node --trace-deprecation ...`)'), null);
});

test('拿不到写入锁时打上 lockHeld，给上层改走「交给 App 排队」', () => {
  assert.equal(summarizeTurn('codex', [], 'Error: failed to acquire thread writer lock for x').lockHeld, true);
  assert.equal(summarizeTurn('codex', [], 'Error: no rollout found').lockHeld, false);
  assert.equal(summarizeTurn('codex', ['{"type":"error","message":"boom"}'], 'failed to acquire thread writer lock').lockHeld, false,
    'stdout 里已经有错误记录，就不是锁的问题');
});

// 2026-11-09 拿真的 codex exec resume 撞 Codex App 占着的锁抓到的 stderr，一字未改。
// 第一版只认 `thread writer lock`，对这段一次都没命中——测试当时用的是推测出来的报错
const REAL_LOCK_STDERR = [
  'Reading prompt from stdin...',
  '2026-11-09T01:32:21.820452Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread 01a1a01d-3e59-7fa1-943a-ea783d8cd850 already has an active writer',
  '2026-11-09T01:32:21.820661Z ERROR codex_core::session: Failed to create session: thread-store conflict: thread 01a1a01d-3e59-7fa1-943a-ea783d8cd850 already has an active writer',
  'Error: thread/resume: thread/resume failed: thread 01a1a01d-3e59-7fa1-943a-ea783d8cd850 already has an active writer (code -32600)',
  '',
].join('\n');

test('真实的 codex 0.164 锁冲突报错（already has an active writer）也认得出来', () => {
  const s = summarizeTurn('codex', [], REAL_LOCK_STDERR);
  assert.equal(s.lockHeld, true);
  assert.match(s.error, /Codex App/);
});
