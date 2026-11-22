import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, listQueue, dropQueue } from '../src/runtime/queue.js';
import { startTurn, listTurns } from '../src/runtime/turns.js';
import { drainQueue, sendMessage, stopTurn, liveTurns } from '../src/http/handlers/turns.js';

/*
  2026-11-14 owner：「我刚刚和 claude 对话，还是不能自己选择插队还是排队啊」。
  原来 Baton 自己那一轮在跑时只能排队；「立刻发」只放行「电脑上那一轮」。
  插队 = 这条放到队列最前、把这一轮停下，停下后的收尾第一个发它。
*/

test('enqueue front：插到最前面，其余顺序不变', () => {
  const key = 'claude:front-order';
  dropQueue(key);
  enqueue({ key, text: 'a' });
  enqueue({ key, text: 'b' });
  enqueue({ key, text: 'c', front: true });
  assert.deepEqual(listQueue(key).map((i) => i.text), ['c', 'a', 'b']);
  dropQueue(key);
});

test('插队等待执行器退出，期间新消息和看门狗都不能抢跑', async () => {
  const key = 'claude:interrupt-1';
  let killed = 0;
  const repo = { getSession: () => ({ key, agent: 'claude', providerId: 'p', cwd: process.cwd() }) };
  const childClose = Promise.withResolvers();
  const queueFinished = Promise.withResolvers();
  const calls = [];
  const deps = {
    repo, config: { allowSend: true }, key,
    env: { ANTHROPIC_AUTH_TOKEN: 'x' }, audit: () => {}, live: () => new Map(),
    push: { send: async () => {} },
    runner: async ({ message, onStart }) => {
      calls.push(message);
      onStart({ kill: () => { killed += 1; } });
      if (message === '第一句') await childClose.promise;
      if (message === '后来排的') queueFinished.resolve();
      return { summary: { status: 'ok', eventCount: 1 } };
    },
  };
  const { body: { turnId } } = await sendMessage({ ...deps, message: '第一句' });
  await sendMessage({ ...deps, message: '原来排着的' });
  const r = await sendMessage({ ...deps, message: '先做这个', when: 'interrupt' });

  assert.equal(r.status, 202);
  assert.equal(r.body.interrupting, true);
  assert.match(r.body.note, /停下后马上发/);
  const repeated = stopTurn({ repo, config: deps.config, key, turnId });
  assert.equal(repeated.body.stopped, false);
  assert.equal(repeated.body.stopping, true);
  assert.equal(killed, 1);
  await sendMessage({ ...deps, message: '后来排的' });
  assert.equal(await drainQueue(deps), null);
  assert.deepEqual(calls, ['第一句']);
  assert.deepEqual(listQueue(key).map((i) => i.text), ['先做这个', '原来排着的', '后来排的']);
  const current = () => listTurns(key).find((x) => x.turnId === turnId);
  assert.equal(current().status, 'running');
  assert.equal(current().endedAt, null);
  childClose.resolve();
  await queueFinished.promise;
  assert.equal(current().status, 'aborted');
  assert.match(current().error, /插队/);
  assert.deepEqual(calls, ['第一句', '先做这个', '原来排着的', '后来排的']);
});

test('桌面端仅能监控时停止和插队都保留现有执行与队列顺序', async () => {
  const key = 'antigravity:monitor-only';
  const done = Promise.withResolvers();
  let kills = 0;
  const deps = {
    repo: { getSession: () => ({ key, agent: 'antigravity', providerId: 'desktop' }) },
    config: { allowSend: true }, key, audit: () => {}, live: () => new Map(),
    runner: async ({ onStart }) => {
      onStart({ canStop: false, kill: () => { kills += 1; } });
      await done.promise;
      return { summary: { status: 'ok', eventCount: 1 } };
    },
  };
  const { body: { turnId } } = await sendMessage({ ...deps, message: '已经交给桌面' });
  assert.equal(listTurns(key)[0].canStop, false, '其他设备和断线重连也要识别这一轮的停止能力');
  const first = await sendMessage({ ...deps, message: '原来排着的' });
  const stop = stopTurn({ repo: deps.repo, config: deps.config, key, turnId });
  assert.equal(stop.body.stopped, false);
  assert.equal(stop.body.stopping, false);
  assert.match(stop.body.note, /桌面/);
  const attempt = await sendMessage({ ...deps, message: '请求插队', when: 'interrupt' });
  assert.equal(attempt.status, 409);
  assert.deepEqual(listQueue(key).map((i) => i.id), [first.body.queueId]);
  assert.equal(listTurns(key)[0].status, 'running');
  assert.equal(kills, 0);
  dropQueue(key);
  done.resolve();
});

test('sendMessage when:auto：照旧排到最后，不停那一轮', async () => {
  const key = 'claude:interrupt-2';
  dropQueue(key);
  const turnId = 'aaaaaaaa-0000-4000-8000-00000000i002';
  startTurn({ key, turnId, agent: 'claude' });
  let killed = 0;
  liveTurns.set(turnId, { kill: () => { killed += 1; } });
  const repo = { getSession: () => ({ key, agent: 'claude', providerId: 'p', cwd: process.cwd() }) };
  const r = await sendMessage({
    repo, config: { allowSend: true }, key, message: '等它跑完', env: { ANTHROPIC_AUTH_TOKEN: 'x' },
    audit: () => {}, live: () => new Map(), runner: () => { throw new Error('不该起'); },
  });
  assert.equal(r.body.queued, true);
  assert.equal(r.body.interrupting, undefined);
  assert.equal(killed, 0);
  liveTurns.delete(turnId);
  dropQueue(key);
});
