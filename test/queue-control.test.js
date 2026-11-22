import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAuth } from '../src/http/auth.js';
import { loadPrincipals, revokedQueueGrant } from '../src/principals.js';
import { createServer } from '../src/http/server.js';
import * as handlers from '../src/http/handlers/turns.js';
import { startTurn, endTurn, listTurns } from '../src/runtime/turns.js';
import { enqueue, listQueue, takeNext, removeQueued, dropQueue } from '../src/runtime/queue.js';
import { tmpDir } from './helpers.js';
import { setGoal } from '../src/http/handlers/goal.js';
import { findReceipt, preserveReceipt, RETRY_WINDOW_MS, withReceipt } from '../src/runtime/receipts.js';

const config = { host: '127.0.0.1', port: 0, allowSend: true };
const configEnv = { ANTHROPIC_AUTH_TOKEN: 'fixture' };
const memberFor = (key) => ({ key, agent: 'claude', providerId: 'ordinary-session', cwd: tmpDir() });

test('暂停的访客队列跨配置和账本恢复保留原 ID，确认移除后才清理', async () => {
  const key = 'claude:recover-guest-queue';
  const dir = tmpDir();
  const member = memberFor(key);
  const file = path.join(dir, 'principals.json');
  const ledger = path.join(dir, 'principal-generations.sqlite');
  const valid = JSON.stringify({ guests: [{ id: 'guest', root: member.cwd, allowSend: true }] });
  const boot = () => createAuth({ token: 'fixture', principals: loadPrincipals({ dir, manageGenerations: true }).principals,
    revokedQueueGrant: (id, generation) => revokedQueueGrant(id, generation, dir) });
  fs.writeFileSync(file, valid);
  const original = boot();
  const principal = original.principalOf('guest');
  const item = enqueue({ key, principalId: 'guest', principalGeneration: principal.generation, text: '留到授权恢复' });
  let sent = 0;
  const drain = (auth) => handlers.drainQueue({ key, repo: { getSession: () => member }, principalOf: auth.principalOf,
    config, env: configEnv, live: () => new Map(), audit() {}, runner: async () => { sent++; return { summary: { status: 'ok', eventCount: 1 } }; } });
  fs.writeFileSync(file, '{');
  await drain(boot());
  assert.deepEqual(listQueue(key), [item]);
  fs.renameSync(ledger, ledger + '.saved');
  try { await drain(original); } finally { fs.renameSync(ledger + '.saved', ledger); }
  assert.deepEqual(listQueue(key), [item]);
  assert.equal(sent, 0);
  fs.writeFileSync(file, valid);
  const restored = boot();
  await (await drain(restored)).settled;
  assert.equal(sent, 1);
  assert.deepEqual(listQueue(key), []);
  enqueue({ key, principalId: 'guest', principalGeneration: principal.generation, text: '已撤权' });
  fs.writeFileSync(file, '{"guests":[]}');
  await drain(boot());
  assert.deepEqual(listQueue(key), []);
  assert.equal(sent, 1);
});

test('durable retry receipts survive pruning, expire at their promised window and never evict a live receipt for capacity', () => {
  const dir = tmpDir();
  const record = { key: 'claude:ttl', principalId: 'owner', turnId: 'one', request: { id: 'r1', signature: 'digest1' } };
  const other = { ...record, turnId: 'two', request: { id: 'r2', signature: 'digest2' } };
  let writes = 0;
  withReceipt(record, () => { writes++; }, { dir, now: 1000, limit: 1 });
  assert.equal(findReceipt(record, { dir, now: 1000 + RETRY_WINDOW_MS - 1 }).turnId, 'one');
  assert.throws(() => withReceipt(other, () => { writes++; }, { dir, now: 1010, limit: 1 }), { code: 'request_history_full' });
  assert.equal(writes, 1);
  assert.equal(findReceipt(record, { dir, now: 1000 + RETRY_WINDOW_MS }), null);
  withReceipt(other, () => { writes++; }, { dir, now: 1000 + RETRY_WINDOW_MS, limit: 1 });
  assert.equal(writes, 2);
});

test('an unreadable or rotating transcript keeps accepted messages until deletion is confirmed', async () => {
  const key = 'claude:temporary-session-gap';
  const dir = tmpDir();
  const item = enqueue({ key, text: '稍后发送' }, { dir });
  const queue = { keys: () => [key], list: () => listQueue(key, { dir }), drop: () => dropQueue(key, { dir }) };
  const recover = (repo) => handlers.reconcileQueues({ repo, queue, config, live: () => new Map() });
  for (const repo of [{ getSession: () => null }, { getSessionForRecovery: () => ({ status: 'unavailable' }), getSession: () => null }]) {
    assert.deepEqual(await recover(repo), []);
    assert.deepEqual(listQueue(key, { dir }), [item]);
  }
  assert.deepEqual(await recover({ getSessionForRecovery: () => ({ status: 'missing' }), getSession: () => null }), [{ key, dropped: 1 }]);
});

test('a transcript disappearing between drain preflight and launch leaves the queue unchanged', async () => {
  const key = 'claude:transient-drain-read';
  const item = enqueue({ key, text: '待执行' });
  const member = memberFor(key);
  let reads = 0;
  const repo = { getSession: () => ++reads === 1 ? member : null };
  await handlers.drainQueue({ repo, key, config, live: () => new Map(), env: configEnv, audit() {},
    runner: async () => assert.fail('unavailable session cannot launch') });
  assert.deepEqual(listQueue(key), [item]);
  dropQueue(key);
});

test('an SQLite COMMIT failure after the durable queue or turn write still dispatches once', async (t) => {
  const key = 'claude:receipt-commit-fails';
  const member = memberFor(key);
  const original = DatabaseSync.prototype.exec;
  let failCommits = true;
  const commit = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (failCommits && sql === 'COMMIT') throw Object.assign(new Error('receipt COMMIT delayed'), { code: 'ERR_SQLITE_ERROR' });
    return original.call(this, sql);
  });
  const closeA = Promise.withResolvers();
  const closeB = Promise.withResolvers();
  const launches = [];
  const send = (message, requestId) => handlers.sendMessage({ key, requestId, message, repo: { getSession: () => member }, config,
    env: configEnv, live: () => new Map(), audit() {}, push: { send: async () => {} }, runner: async (r) => {
      launches.push(r.message);
      await (r.message === '第一条' ? closeA : closeB).promise;
      return { summary: { status: 'ok', eventCount: 1 } };
    } });
  const first = await send('第一条', 'a');
  assert.equal((await send('第二条', 'b')).status, 503, '新接收需先确认回执索引恢复');
  failCommits = false;
  preserveReceipt(listTurns(key)[0]);
  failCommits = true;
  const next = await send('第二条', 'b');
  assert.equal(first.status, 202);
  assert.equal(next.status, 202);
  assert.equal((await send('第一条', 'a')).body.turnId, first.body.turnId);
  assert.equal((await send('第二条', 'b')).body.queueId, next.body.queueId);
  assert.throws(() => removeQueued(key, next.body.queueId), { code: 'receipt_store_unavailable' });
  assert.equal(listQueue(key)[0].id, next.body.queueId);
  closeA.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launches, ['第一条', '第二条']);
  assert.equal(listQueue(key).length, 0);
  assert.equal((await send('第二条', 'b')).body.queueId, next.body.queueId);
  closeB.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(listTurns(key).every((turn) => turn.status === 'ok'));
  commit.mock.restore();
  startTurn({ key, turnId: 'newer', agent: 'claude' });
  endTurn({ key, turnId: 'newer', status: 'ok', eventCount: 1 }, { keep: 1 });
  assert.equal((await send('第一条', 'a')).body.turnId, first.body.turnId);
  assert.equal((await send('第二条', 'b')).body.queueId, next.body.queueId);
});

test('goal sends retain the principal resolver and temporarily unresolvable queued messages stay in place', async () => {
  const key = 'claude:goal-resolver';
  const member = memberFor(key);
  const repo = { getSession: () => member };
  const principal = { id: 'teammate', roots: null, generation: 'current' };
  const principalOf = () => principal;
  for (const agent of ['claude', 'antigravity', 'codex']) {
    member.agent = agent;
    for (const clear of agent === 'codex' ? [false] : [false, true]) {
      await setGoal({ repo, config, principal, principalOf, key, objective: '按顺序处理', clear,
        codex: { set: async () => ({}) }, send: async (o) => {
          assert.equal(o.principalOf, principalOf);
          return { status: 202, body: {} };
        } });
    }
  }
  member.agent = 'claude';
  const item = enqueue({ key, text: '保留', principalId: principal.id, principalGeneration: principal.generation });
  const deps = { repo, config, key, live: () => new Map(), audit: () => {},
    runner: async () => { throw new Error('不该执行'); } };
  await handlers.drainQueue(deps);
  assert.equal(listQueue(key)[0].id, item.id);
  await handlers.drainQueue({ ...deps, principalOf, env: { PATH: '', USERPROFILE: tmpDir(), HOME: tmpDir() } });
  assert.equal(listQueue(key)[0].id, item.id, '缺少执行条件时保留原 ID');
  dropQueue(key);
});

test('withdrawing an accepted item from interrupted persistence keeps its receipt', () => {
  const key = 'claude:receipt-repair';
  const dir = tmpDir();
  const item = enqueue({ key, text: '正常排队' }, { dir });
  item.request = { id: 'original-id', signature: 'body-digest' };
  fs.writeFileSync(path.join(dir, 'queue', `${encodeURIComponent(key)}.jsonl`), JSON.stringify(item) + '\n');
  assert.equal(findReceipt(item, { dir }), null);
  removeQueued(key, item.id, { dir });
  assert.equal(findReceipt(item, { dir })?.queueId, item.id);
});

test('goal continuation reauthorizes its original sender after awaiting the goal', async () => {
  const key = 'codex:goal-changed-authorization';
  const member = { ...memberFor(key), agent: 'codex' };
  const previous = { id: 'guest', generation: 'v1', roots: null, allowSend: true };
  for (const current of [null, { ...previous, generation: 'v2' }, { ...previous, allowSend: false }, { ...previous, roots: [] }]) {
    const checking = Promise.withResolvers();
    let principal = previous;
    let ran = 0;
    const result = handlers.continueGoal({ key, repo: { getSession: () => member }, config, principal: previous,
      principalOf: () => principal, goalOf: () => checking.promise, deps: { live: () => new Map(), queue: { list: () => [] },
        turns: { latest: () => ({ status: 'ok' }), start: () => {}, end: () => {} }, audit: () => {},
        runner: async () => { ran++; return { summary: { status: 'failed' } }; } } });
    principal = current;
    checking.resolve({ status: 'active' });
    assert.equal(await result, false);
    assert.equal(ran, 0);
  }
});

test('a rejected stop or an audit write failure leaves the promoted item at its original position', async () => {
  const key = 'claude:promote-rollback';
  const turnId = 'active';
  const repo = { getSession: () => memberFor(key) };
  startTurn({ key, turnId, agent: 'claude' });
  const a = enqueue({ key, text: '先排队' });
  const b = enqueue({ key, text: '后排队' });
  handlers.liveTurns.set(turnId, { kill() {} });
  const opts = { repo, key, id: b.id, config, env: configEnv, live: () => new Map() };
  try {
    await assert.rejects(handlers.promoteQueued({ ...opts, turns: { control() { throw new Error('未能记录停止请求'); } } }), /未能记录停止请求/);
    assert.deepEqual(listQueue(key), [a, b]);
    endTurn({ key, turnId, status: 'ok', eventCount: 1 });
    await assert.rejects(handlers.promoteQueued({ ...opts, audit() { throw new Error('审计暂时不可写'); } }), /审计暂时不可写/);
    assert.deepEqual(listQueue(key), [a, b]);
  } finally {
    handlers.liveTurns.delete(turnId);
    dropQueue(key);
  }
});

test('last queue item stays persisted and cannot run or be reported withdrawn after a failed unlink', async (t) => {
  const key = 'claude:queue-persist-failure';
  const member = memberFor(key);
  const item = enqueue({ key, text: '保留这条消息' });
  const storage = path.join(process.env.BATON_DIR, 'queue', `${encodeURIComponent(key)}.jsonl`);
  const original = fs.unlinkSync;
  const unlink = t.mock.method(fs, 'unlinkSync', (file) => {
    if (file === storage) throw Object.assign(new Error('队列暂时不可写'), { code: 'EBUSY' });
    return original(file);
  });
  const repo = { getSession: () => member };
  let starts = 0;
  await assert.rejects(handlers.drainQueue({ repo, config, key, env: configEnv, live: () => new Map(),
    runner: async () => { starts++; return { summary: { status: 'ok', eventCount: 1 } }; }, audit: () => {} }), /队列暂时不可写/);
  assert.throws(() => removeQueued(key, item.id), /队列暂时不可写/);
  assert.throws(() => dropQueue(key), /队列暂时不可写/);
  assert.equal(starts, 0);
  assert.equal(listQueue(key)[0].id, item.id);
  unlink.mock.restore();
  assert.equal(takeNext(key).id, item.id);
});

test('send retries return the same acceptance across queue, execution and completion and isolate principals', async () => {
  const key = 'claude:retry-delivery';
  const member = memberFor(key);
  const closeFirst = Promise.withResolvers();
  const closeSecond = Promise.withResolvers();
  const secondStarted = Promise.withResolvers();
  const launched = [];
  const deps = { key, config, repo: { getSession: () => member }, env: configEnv,
    live: () => new Map(), audit: () => {}, push: { send: async () => {} },
    runner: async ({ message }) => {
      launched.push(message);
      if (message === '第一轮') await closeFirst.promise;
      if (message === '下一轮') { secondStarted.resolve(); await closeSecond.promise; }
      return { summary: { status: 'ok', eventCount: 1 } };
    } };
  const send = (message, requestId, opts = {}) => handlers.sendMessage({ ...deps, message, requestId, ...opts });
  const [first, duplicate] = await Promise.all([send('第一轮', 'r1'), send('第一轮', 'r1')]);
  assert.equal(duplicate.body.turnId, first.body.turnId);
  assert.equal(duplicate.body.queued, false);
  const queued = await send('下一轮', 'r2');
  assert.equal((await send('下一轮', 'r2')).body.queueId, queued.body.queueId);
  assert.equal((await send('不同文本', 'r2')).status, 409);
  assert.equal((await send('下一轮', 'r2', { when: 'interrupt' })).status, 409);
  assert.equal((await send('无效标识', 'space invalid')).status, 400);
  const guest = await send('另一个用户', 'r2', { principal: { id: 'guest', generation: 'g1' } });
  assert.notEqual(guest.body.queueId, queued.body.queueId);
  removeQueued(key, guest.body.queueId);
  const revoked = await send('另一个用户', 'r2', { principal: { id: 'guest', generation: 'g1' } });
  assert.equal(revoked.body.queueId, guest.body.queueId, '撤回也保留原回执');
  assert.deepEqual(listQueue(key).map((q) => q.id), [queued.body.queueId]);
  closeFirst.resolve();
  await secondStarted.promise;
  assert.equal((await send('下一轮', 'r2')).body.queueId, queued.body.queueId);
  closeSecond.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await send('下一轮', 'r2')).body.queueId, queued.body.queueId);
  assert.equal((await send('第一轮', 'r1')).body.turnId, first.body.turnId);
  assert.deepEqual(launched, ['第一轮', '下一轮']);
  startTurn({ key, turnId: 'more-recent', agent: member.agent });
  endTurn({ key, turnId: 'more-recent', status: 'ok', eventCount: 1 }, { keep: 1 });
  assert.equal(listTurns(key).some((turn) => turn.turnId === first.body.turnId), false);
  assert.equal((await send('第一轮', 'r1')).body.turnId, first.body.turnId);
  assert.deepEqual(launched, ['第一轮', '下一轮']);
});

test('idle promotion executes the original fork and sender once, retaining its place when preflight fails', async () => {
  const key = 'claude:idle-promotion';
  const member = memberFor(key);
  const principal = { id: 'guest', generation: 'g', roots: null, allowSend: true };
  const a = enqueue({ key, text: '保留队首' });
  const b = enqueue({ key, text: '有分叉的消息', fork: true, principalId: 'guest', principalGeneration: 'g' });
  const finished = Promise.withResolvers();
  const launched = [];
  const opts = { key, id: b.id, repo: { getSession: () => member }, config, principalOf: () => principal,
    live: () => new Map(), audit: () => {}, runner: async (o) => {
      launched.push([o.message, o.fork]);
      await finished.promise;
      return { summary: { status: 'ok', eventCount: 1 } };
    } };
  assert.equal((await handlers.promoteQueued({ ...opts, env: {} })).status, 503);
  assert.deepEqual(listQueue(key).map((q) => q.id), [a.id, b.id]);
  const r = await handlers.promoteQueued({ ...opts, env: configEnv });
  assert.equal(r.body.queued, false);
  assert.equal((await handlers.promoteQueued({ ...opts, env: configEnv })).body.turnId, r.body.turnId);
  assert.deepEqual(launched, [['有分叉的消息', true]]);
  assert.equal(listTurns(key)[0].principalId, 'guest');
  assert.deepEqual(listQueue(key).map((q) => q.id), [a.id]);
  dropQueue(key);
  finished.resolve();
});

test('HTTP queue promotion keeps the original item, refuses monitor-only runs and is stable on retry', async (t) => {
  const key = 'antigravity:http-queue-promotion';
  const member = { ...memberFor(key), agent: 'antigravity' };
  const repo = { getSession: () => member };
  const auth = createAuth({ token: 'queue-test' });
  const server = createServer({ repo, config, auth });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/sessions/${encodeURIComponent(key)}/queue/promote`;
  const post = async (id) => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer queue-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    return { status: res.status, body: await res.json() };
  };
  const turnId = 'live-execution';
  startTurn({ key, turnId, agent: member.agent });
  const a = enqueue({ key, text: '第一个' });
  const b = enqueue({ key, text: '第二个', fork: true });
  const send = () => fetch(url.replace('/queue/promote', '/send'), { method: 'POST', headers: { Authorization: 'Bearer queue-test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '回执重试', requestId: 'http-retry' }) }).then((r) => r.json());
  const [accepted, again] = await Promise.all([send(), send()]);
  assert.equal(accepted.queueId, again.queueId);
  assert.equal(listQueue(key).filter((q) => q.text === '回执重试').length, 1);
  removeQueued(key, accepted.queueId);
  handlers.liveTurns.set(turnId, { canStop: false });
  assert.equal((await post(b.id)).body.error.code, 'stop_unavailable');
  assert.deepEqual(listQueue(key).map((q) => q.id), [a.id, b.id]);
  let stopped = 0;
  handlers.liveTurns.set(turnId, { kill: () => { stopped++; } });
  const [one, two] = await Promise.all([post(b.id), post(b.id)]);
  assert.equal(one.status, 202);
  assert.equal(two.status, 202);
  assert.equal(one.body.queueId, b.id);
  assert.equal(one.body.interrupting, true);
  assert.equal(stopped, 1);
  assert.deepEqual(listQueue(key), [b, a]);
  assert.equal(listTurns(key)[0].status, 'running');
  assert.equal((await post('gone')).status, 404);
  handlers.liveTurns.delete(turnId);
  endTurn({ key, turnId, status: 'ok', eventCount: 1 });
  dropQueue(key);
});
