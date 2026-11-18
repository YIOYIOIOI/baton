import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, listQueue, dropQueue } from '../src/runtime/queue.js';
import { startTurn, listTurns } from '../src/runtime/turns.js';
import { sendMessage, liveTurns } from '../src/http/handlers/turns.js';

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

test('sendMessage when:interrupt：Baton 那一轮在跑 → 这条排到最前、那一轮被停下，终态写明是插队', async () => {
  const key = 'claude:interrupt-1';
  dropQueue(key);
  enqueue({ key, text: '原来排着的' });
  const turnId = 'aaaaaaaa-0000-4000-8000-00000000i001';
  startTurn({ key, turnId, agent: 'claude', prompt: '正在跑的那句' });
  let killed = 0;
  liveTurns.set(turnId, { kill: () => { killed += 1; } });
  const repo = { getSession: () => ({ key, agent: 'claude', providerId: 'p', cwd: process.cwd() }) };

  const r = await sendMessage({
    repo, config: { allowSend: true }, key, message: '先做这个', when: 'interrupt',
    env: { ANTHROPIC_AUTH_TOKEN: 'x' }, audit: () => {}, live: () => new Map(),
    runner: () => { throw new Error('插队不该当场起进程——要等那一轮停下后的收尾去发'); },
  });

  assert.equal(r.status, 202);
  assert.equal(r.body.interrupting, true);
  assert.match(r.body.note, /停下后马上发/);
  assert.equal(killed, 1, '那一轮的进程被停了');
  assert.deepEqual(listQueue(key).map((i) => i.text), ['先做这个', '原来排着的'], '插到最前，原来排着的往后挪');
  const t = listTurns(key).find((x) => x.turnId === turnId);
  assert.equal(t.status, 'aborted');
  assert.match(t.error, /插队/);
  dropQueue(key);
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
