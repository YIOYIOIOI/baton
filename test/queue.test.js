import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sendMessage, drainQueue, cancelQueued, reconcileQueues, watchQueues } from '../src/http/handlers/turns.js';
import { sessionState } from '../src/http/handlers/sessions.js';
import {
  enqueue, listQueue, takeNext, dropQueue, queuedKeys, removeQueued,
} from '../src/runtime/queue.js';
import { tmpDir } from './helpers.js';

// 守的是 v1 的一个真实缺陷：sendMessage 原先不检查该会话是否已有轮次在跑，
// 会直接再起一个 `claude --resume`。两个进程同时续写同一个 transcript，
// 第二轮读到的上下文里没有第一轮尚未写完的消息——两轮基于分叉的上下文各自作答。
// 这是语义损坏，与写入是否原子无关。

const member = {
  key: 'claude:queue-test', agent: 'claude',
  providerId: 'aaaaaaaa-0000-4000-8000-00000000q001', cwd: 'C:\\proj', file: 'x',
};
const repo = { getSession: (k) => (k === member.key ? member : null) };
const ENV = { ANTHROPIC_AUTH_TOKEN: 'test-token' };
const CFG = { allowSend: true };

// 每个测试一个独立的队列目录，否则彼此串数据
const freshQueue = () => {
  const dir = tmpDir();
  return {
    dir,
    enqueue: (i) => enqueue(i, { dir }),
    takeNext: (k) => takeNext(k, { dir }),
    list: (k) => listQueue(k, { dir }),
    keys: () => queuedKeys({ dir }),
    drop: (k) => dropQueue(k, { dir }),
  };
};

const runningTurns = (turnId = 'RUNNING') => ({
  start: () => {}, end: () => ({ status: 'ok' }),
  latest: () => ({ turnId, status: 'running', startedAt: 0 }),
});
const idleTurns = { start: () => {}, end: () => ({ status: 'ok' }), latest: () => null };

// ── 落盘队列本身 ──────────────────────────────────

test('入队、按序取出、取走即消失', () => {
  const dir = tmpDir();
  enqueue({ key: 'k', text: '第一条' }, { dir });
  enqueue({ key: 'k', text: '第二条' }, { dir });
  assert.deepEqual(listQueue('k', { dir }).map((i) => i.text), ['第一条', '第二条']);

  assert.equal(takeNext('k', { dir }).text, '第一条');
  assert.deepEqual(listQueue('k', { dir }).map((i) => i.text), ['第二条']);
  assert.equal(takeNext('k', { dir }).text, '第二条');
  assert.equal(takeNext('k', { dir }), null, '空队列返回 null，不是抛错');
});

test('队列落盘，守护进程重启不丢——用户以为已经说出去了', () => {
  const dir = tmpDir();
  enqueue({ key: 'k', text: '别丢我' }, { dir });
  // 新的「进程」只拿到目录，读回来必须还在
  assert.equal(listQueue('k', { dir })[0].text, '别丢我');
});

test('含特殊字符的 key 能正确往返（key 是 base64url + 冒号）', () => {
  const dir = tmpDir();
  const key = 'claude:Qy0tcHJvai9hYmM_ZGVm';
  enqueue({ key, text: 'x' }, { dir });
  assert.deepEqual(queuedKeys({ dir }), [key]);
  assert.equal(takeNext(key, { dir }).text, 'x');
});

test('坏行跳过，不卡住整条队列', () => {
  const dir = tmpDir();
  enqueue({ key: 'k', text: '好的' }, { dir });
  fs.appendFileSync(path.join(dir, 'queue', `${encodeURIComponent('k')}.jsonl`), '{坏行\n');
  enqueue({ key: 'k', text: '后面的' }, { dir });
  assert.deepEqual(listQueue('k', { dir }).map((i) => i.text), ['好的', '后面的']);
});

// ── 并发守卫 ────────────────────────────────────

test('已有轮次在跑时排队，绝不起第二个进程', async () => {
  const queue = freshQueue();
  let spawned = 0;
  const runner = async () => { spawned += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; };

  const r = await sendMessage({
    repo, config: CFG, key: member.key, message: '纠偏一下',
    runner, env: ENV, turns: runningTurns(), queue,
  });

  assert.equal(spawned, 0, '两个 --resume 同时续写同一个 transcript 是语义损坏');
  assert.equal(r.status, 202);
  assert.equal(r.body.queued, true);
  assert.equal(r.body.afterTurnId, 'RUNNING');
  assert.equal(r.body.queueLength, 1);
  assert.deepEqual(queue.list(member.key).map((i) => i.text), ['纠偏一下']);
});

test('排队回执必须说清何时发出——「不停止地纠偏」会被读成中途打断', async () => {
  const queue = freshQueue();
  const r = await sendMessage({
    repo, config: CFG, key: member.key, message: 'x',
    runner: async () => ({ code: 0, lines: [], summary: {} }), env: ENV,
    turns: runningTurns(), queue,
  });
  assert.match(r.body.note, /这轮结束后发出|结束后发出/);
  assert.match(r.body.note, /不会被打断|不会打断/);
});

test('没有轮次在跑时照常起进程，且明示未排队', async () => {
  const queue = freshQueue();
  let spawned = 0;
  const runner = async () => { spawned += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; };

  const r = await sendMessage({
    repo, config: CFG, key: member.key, message: '你好',
    runner, env: ENV, turns: idleTurns, queue,
  });
  assert.equal(r.status, 202);
  assert.equal(r.body.queued, false);
  assert.ok(r.body.turnId);
  assert.equal(spawned, 1);
  assert.equal(queue.list(member.key).length, 0);
});

test('排队发生在校验之后——空消息不该混进队列', async () => {
  const queue = freshQueue();
  const r = await sendMessage({
    repo, config: CFG, key: member.key, message: '   ',
    runner: async () => ({}), env: ENV, turns: runningTurns(), queue,
  });
  assert.equal(r.status, 400);
  assert.equal(queue.list(member.key).length, 0);
});

test('只读模式下不排队——否则一开 allowSend 就会涌出一堆旧消息', async () => {
  const queue = freshQueue();
  const r = await sendMessage({
    repo, config: { allowSend: false }, key: member.key, message: 'x',
    runner: async () => ({}), env: ENV, turns: runningTurns(), queue,
  });
  assert.equal(r.status, 403);
  assert.equal(queue.list(member.key).length, 0);
});

// ── 排空 ────────────────────────────────────────

test('一轮结束后自动发出队首', async () => {
  const queue = freshQueue();
  queue.enqueue({ key: member.key, text: '排着的那条' });

  const sent = [];
  const runner = async (o) => { sent.push(o.message); return { code: 0, lines: [], summary: { status: 'ok' } }; };

  // 第一轮：起进程，结束后 settle 会去排空
  await sendMessage({
    repo, config: CFG, key: member.key, message: '第一条',
    runner, env: ENV, turns: idleTurns, queue,
  });
  await new Promise((r) => setImmediate(r)); // 让 .then(settle) 跑完
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(sent, ['第一条', '排着的那条']);
  assert.equal(queue.list(member.key).length, 0, '发出后要从队列里消失');
});

test('失败的一轮同样放行队列——否则一次失败就把队列永远堵死', async () => {
  const queue = freshQueue();
  queue.enqueue({ key: member.key, text: '后面那条' });

  const sent = [];
  const runner = async (o) => {
    sent.push(o.message);
    if (o.message === '会炸的') throw new Error('agent 崩了');
    return { code: 0, lines: [], summary: { status: 'ok' } };
  };

  await sendMessage({
    repo, config: CFG, key: member.key, message: '会炸的',
    runner, env: ENV, turns: idleTurns, queue,
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(sent, ['会炸的', '后面那条']);
});

// ── 重启收尾 ────────────────────────────────────

test('守护进程启动时排空遗留队列（与 intents 的 reconcileOrphans 对等）', async () => {
  const queue = freshQueue();
  queue.enqueue({ key: member.key, text: '上次没发出去的' });

  const sent = [];
  const runner = async (o) => { sent.push(o.message); return { code: 0, lines: [], summary: { status: 'ok' } }; };

  const resumed = await reconcileQueues({
    repo, config: CFG, runner, env: ENV, turns: idleTurns, queue,
  });
  assert.deepEqual(sent, ['上次没发出去的']);
  assert.deepEqual(resumed, [{ key: member.key, sent: 1 }]);
});

test('会话已不存在时清掉队列，不让它永远留在盘上', async () => {
  const queue = freshQueue();
  queue.enqueue({ key: 'claude:早就删了', text: 'x' });

  const resumed = await reconcileQueues({
    repo: { ...repo, getSessionForRecovery: () => ({ status: 'missing' }) },
    config: CFG, runner: async () => ({}), env: ENV, turns: idleTurns, queue,
  });
  assert.deepEqual(resumed, [{ key: 'claude:早就删了', dropped: 1 }]);
  assert.deepEqual(queue.keys(), []);
});

// ── 透出给客户端 ─────────────────────────────────

test('sessionState 带出排队中的消息——不透出用户会以为发丢了再发一条', () => {
  const dir = tmpDir();
  enqueue({ key: member.key, text: '排着的' }, { dir });
  const r = sessionState({
    repo, key: member.key,
    turns: () => [{ turnId: 'T', status: 'running', startedAt: 0 }],
    queue: (k) => listQueue(k, { dir }),
  });
  assert.equal(r.body.running, true);
  assert.deepEqual(r.body.queued.map((i) => i.text), ['排着的']);
  assert.ok(r.body.queued[0].id, '要有 id，客户端才能对应上自己刚发的那条');
});

test('队列项带 principalId，缺失时（旧版遗留）视为 owner', () => {
  const dir = tmpDir();
  enqueue({ key: 'claude:k', text: '一', principalId: 'friend' }, { dir });
  assert.equal(listQueue('claude:k', { dir })[0].principalId, 'friend');

  // 旧版写下的队列项没有这个字段，读到时不能变成 undefined 到处传
  fs.appendFileSync(
    path.join(dir, 'queue', `${encodeURIComponent('claude:k')}.jsonl`),
    `${JSON.stringify({ id: 'old', key: 'claude:k', text: '二', fork: false, queuedAt: 1 })}\n`,
  );
  const items = listQueue('claude:k', { dir });
  assert.equal(items[1].principalId, 'owner');
});

// ── 电脑上那轮跑完了，排着的消息得有人放出来（2026-10-09）──────────────
//
// Baton 自己那轮结束时会顺手排空（sendMessage 的 settle）。电脑上起的那轮没人
// 通知 Baton，所以得有个定时的看一眼。

test('看门狗按节拍排空；上一拍还没跑完就跳过这一拍', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let release;
  const stop = watchQueues({
    repo: {}, config: {}, everyMs: 5000,
    reconcile: () => { calls += 1; return new Promise((r) => { release = r; }); },
  });

  // 每次 tick 之后都要让微任务跑完再断言：真正调 reconcile 的是一个 .then，
  // 紧挨着 tick 断言等于在它执行之前就下结论
  const settle = () => new Promise((done) => setImmediate(done));

  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 1);

  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 1, '上一拍的排空还没结束，这一拍不许再进来');

  release();
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 2, '上一拍结束了，下一拍照常');

  stop();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 2, '停了就是停了');
});

test('排空自己抛了也不许把看门狗带走', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const stop = watchQueues({
    repo: {}, config: {}, everyMs: 1000,
    reconcile: () => { calls += 1; throw new Error('读盘炸了'); },
  });
  t.mock.timers.tick(1000);
  await new Promise((done) => setImmediate(done));
  t.mock.timers.tick(1000);
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 2);
  stop();
});

test('sessionState 带出「电脑上那轮」——发之前就该知道这条会排队', () => {
  const key = 'claude:host-busy';
  const member = { key, agent: 'claude', providerId: 'dddddddd-0000-4000-8000-000000000004', cwd: 'C:\\p' };
  const repo = { getSession: (k) => (k === key ? member : null) };
  const base = { repo, key, turns: () => [], queue: () => [], prefs: { get: () => null, effort: () => null } };

  assert.equal(sessionState({ ...base, live: () => new Map() }).body.host, null);
  assert.equal(sessionState({ ...base, live: () => new Map([[member.providerId, 'busy']]) }).body.host, 'busy');
  const w = sessionState({ ...base, live: () => new Map([[member.providerId, 'waiting']]) }).body;
  assert.equal(w.host, 'waiting');
  assert.equal(w.running, false, 'host 不许混进 running：停止按钮认的是 running，而电脑上那轮 Baton 停不了');
});

test('排空只认 busy：电脑上开着个框时，排着的消息照样放出去', async () => {
  // 反过来说才对：这条消息已经排在那儿等着出去了，拿一个要人在电脑前点的框
  // 把它继续扣住，正是 owner 否掉的那种卡死。
  const dir = tmpDir();
  const key = 'claude:drain-waiting';
  const member = { key, agent: 'claude', providerId: 'eeeeeeee-0000-4000-8000-000000000005', cwd: 'C:\\p' };
  enqueue({ key, text: '排着的那条', principalId: 'owner' }, { dir });

  let sent = 0;
  const r = await drainQueue({
    repo: { getSession: (k) => (k === key ? member : null) },
    config: { allowSend: true },
    key,
    runner: async () => { sent += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; },
    env: { ANTHROPIC_AUTH_TOKEN: 't' },
    live: () => new Map([[member.providerId, 'waiting']]),
    turns: { start: () => {}, end: () => ({ status: 'ok' }), latest: () => null },
    queue: {
      enqueue: (i) => enqueue(i, { dir }),
      takeNext: (k) => takeNext(k, { dir }),
      list: (k) => listQueue(k, { dir }),
    },
  });
  assert.equal(r?.status, 202);
  assert.equal(r.body.queued, false, '不能又塞回队列里');
  await new Promise((done) => setImmediate(done));
  assert.equal(sent, 1);
});

// ── 撤回排着的那条（owner 2026-10-09：「排队的消息现在还不能撤回」）──────────

test('removeQueued 按 id 拿掉一条，其余顺序不动', () => {
  const dir = tmpDir();
  const key = 'claude:cancel';
  const a = enqueue({ key, text: '第一条' }, { dir });
  const b = enqueue({ key, text: '第二条' }, { dir });
  const c = enqueue({ key, text: '第三条' }, { dir });

  assert.deepEqual(removeQueued(key, b.id, { dir }), { id: b.id, text: '第二条' });
  assert.deepEqual(listQueue(key, { dir }).map((i) => i.text), ['第一条', '第三条']);
  // 没有这条 id、队列是空的——都返回 null，不抛
  assert.equal(removeQueued(key, 'no-such-id', { dir }), null);
  assert.equal(removeQueued('claude:别的会话', a.id, { dir }), null);
  removeQueued(key, a.id, { dir });
  removeQueued(key, c.id, { dir });
  assert.equal(removeQueued(key, c.id, { dir }), null);
  assert.deepEqual(listQueue(key, { dir }), []);
});

test('cancelQueued：撤回要有身份校验，别人的会话撤不了', () => {
  const dir = tmpDir();
  const key = 'claude:abc';
  const member = { key, agent: 'claude', providerId: 'ffffffff-0000-4000-8000-000000000006', cwd: 'C:\\p' };
  const repo = { getSession: (k) => (k === key ? member : null) };
  const item = enqueue({ key, text: '撤回我' }, { dir });

  const miss = cancelQueued({ repo, key: 'claude:不存在', id: item.id, queue: { remove: (k, i) => removeQueued(k, i, { dir }) } });
  assert.equal(miss.status, 404, '会话都看不见，当然撤不了');

  const gone = cancelQueued({ repo, key, id: 'no-such', queue: { remove: (k, i) => removeQueued(k, i, { dir }) } });
  assert.equal(gone.status, 404, '那条已经发出去了，要如实说，不能假装撤掉了');
  assert.match(gone.body.error.message, /已经/);

  const ok = cancelQueued({ repo, key, id: item.id, queue: { remove: (k, i) => removeQueued(k, i, { dir }) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cancelled, true);
  assert.deepEqual(listQueue(key, { dir }), []);
});

// ── 立刻发送（owner：「应该要可以自己决定要不要直接发送吧」）──────────────

test('when:now 时不排队，电脑上在跑也照发', async () => {
  const key = 'claude:now';
  const member = { key, agent: 'claude', providerId: 'ffffffff-0000-4000-8000-000000000007', cwd: 'C:\\p' };
  let spawned = 0;
  let queued = 0;
  const r = await sendMessage({
    repo: { getSession: () => member },
    config: { allowSend: true },
    key,
    message: '现在就发',
    when: 'now',
    runner: async () => { spawned += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; },
    env: { ANTHROPIC_AUTH_TOKEN: 't' },
    live: () => new Map([[member.providerId, 'busy']]),
    turns: { start: () => {}, end: () => ({ status: 'ok' }), latest: () => null },
    queue: { enqueue: () => { queued += 1; return { id: 'x' }; }, list: () => [], takeNext: () => null },
  });
  assert.equal(r.body.queued, false);
  assert.equal(queued, 0);
  await new Promise((done) => setImmediate(done));
  assert.equal(spawned, 1);
});

test('when:now 挡不住 Baton 自己那一轮——那一轮是我们起的，停都停得了，不该绕过它', async () => {
  const key = 'claude:now2';
  const member = { key, agent: 'claude', providerId: 'ffffffff-0000-4000-8000-000000000008', cwd: 'C:\\p' };
  let spawned = 0;
  const r = await sendMessage({
    repo: { getSession: () => member },
    config: { allowSend: true },
    key,
    message: '插一句',
    when: 'now',
    runner: async () => { spawned += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; },
    env: { ANTHROPIC_AUTH_TOKEN: 't' },
    live: () => new Map(),
    turns: { start: () => {}, end: () => ({}), latest: () => ({ status: 'running', turnId: 'T1' }) },
    queue: { enqueue: () => ({ id: 'q1' }), list: () => [{}], takeNext: () => null },
  });
  assert.equal(r.body.queued, true, '要插队得先停掉那一轮，不能让两个进程同时写');
  assert.equal(spawned, 0);
});
