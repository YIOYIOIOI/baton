import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { defaultRunner } from '../src/http/handlers/turns.js';
import { queueToCodexApp, HANDOFF_NOTE } from '../src/agent/codexQueue.js';
import { classifyOutcome } from '../src/runtime/turns.js';

// 2026-11-09：Codex App 开着会话、占着写入锁时，Baton 不再报失败，而是把消息交给 App 排队

const member = {
  key: 'codex:abc', agent: 'codex', providerId: '01a1a01d-3e59-7fa1-943a-ea783d8cd850', cwd: process.cwd(),
};
// 2026-11-09 真实抓到的那段（见 agent-adapt.test.js 的 REAL_LOCK_STDERR）。原来这里是凭推测写的另一句
const LOCK = 'Reading prompt from stdin...\n'
  + 'Error: thread/resume: thread/resume failed: thread 01a1a01d-3e59-7fa1-943a-ea783d8cd850 already has an active writer (code -32600)\n';

test('defaultRunner：resume 拿不到写入锁 → 交给 App 排队，这一轮记为 handoff', async () => {
  let asked = null;
  const r = await defaultRunner({
    member, message: '帮我看看', fork: false, turnId: 't1',
    run: async () => ({ code: 1, lines: [], stderr: LOCK, timedOut: false }),
    toApp: async (o) => { asked = o; return { id: 'q1' }; },
  });
  assert.deepEqual(asked, { threadId: member.providerId, text: '帮我看看' });
  assert.equal(r.summary.status, 'handoff');
  assert.equal(r.summary.queuedId, 'q1');
  assert.equal(r.summary.error, HANDOFF_NOTE);
});

test('defaultRunner：排队也失败时照报失败，两个原因都说', async () => {
  const r = await defaultRunner({
    member, message: 'x', fork: false, turnId: 't2',
    run: async () => ({ code: 1, lines: [], stderr: LOCK, timedOut: false }),
    toApp: async () => { throw new Error('codex 没在时限内回话'); },
  });
  assert.equal(r.summary.status, 'failed');
  assert.match(r.summary.error, /Codex App/);
  assert.match(r.summary.error, /时限/);
});

test('defaultRunner：别的失败、分叉、claude 都不走交给 App 那条', async () => {
  let called = 0;
  const toApp = async () => { called += 1; return { id: 'q' }; };
  const other = await defaultRunner({
    member, message: 'x', fork: false, turnId: 't3', toApp,
    run: async () => ({ code: 1, lines: [], stderr: 'Error: no rollout found', timedOut: false }),
  });
  assert.equal(other.summary.status, 'failed');
  const forked = await defaultRunner({
    member, message: 'x', fork: true, turnId: 't4', toApp,
    run: async () => ({ code: 1, lines: [], stderr: LOCK, timedOut: false }),
  });
  assert.equal(forked.summary.status, 'failed');
  assert.equal(called, 0);
});

test('classifyOutcome：handoff 是它自己的终态，不因零消息被判成异常', () => {
  assert.equal(classifyOutcome({ status: 'handoff', eventCount: 0 }), 'handoff');
});

/** 一个假的 codex app-server：按 JSON-RPC 回 initialize 与 thread/queue/add */
function fakeServer({ addError = null } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.pid = 0; // 让收尾走 child.kill 分支
  child.kill = () => {};
  const seen = [];
  let buf = '';
  child.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      seen.push(m);
      if (m.id === 1) child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'x' } })}\n`);
      if (m.id === 2) {
        child.stdout.write(`${JSON.stringify(addError
          ? { id: 2, error: { message: addError } }
          : { id: 2, result: { queuedSubmission: { id: 'qs-1', input: m.params.input, clientUserMessageId: m.params.clientUserMessageId } } })}\n`);
      }
    }
  });
  return { child, seen };
}

test('queueToCodexApp：声明 experimentalApi，按 ThreadQueueAddParams 的形状排一条文本', async () => {
  const { child, seen } = fakeServer();
  const r = await queueToCodexApp({ threadId: 'th', text: '你好', spawnFn: () => child });
  assert.deepEqual(r, { id: 'qs-1' });
  assert.equal(seen[0].params.capabilities.experimentalApi, true);
  const add = seen.find((m) => m.method === 'thread/queue/add');
  assert.equal(add.params.threadId, 'th');
  assert.deepEqual(add.params.input, [{ type: 'text', text: '你好', text_elements: [] }]);
  assert.match(add.params.clientUserMessageId, /^[0-9a-f-]{36}$/);
});

test('queueToCodexApp：codex 回错误就报出来', async () => {
  const { child } = fakeServer({ addError: 'thread not found' });
  await assert.rejects(queueToCodexApp({ threadId: 'th', text: 'x', spawnFn: () => child }), /thread not found/);
});
