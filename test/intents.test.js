import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeIntent, pendingIntents, consumeIntent, reconcileOrphans } from '../src/runtime/intents.js';
import { startTurn, latestTurn } from '../src/runtime/turns.js';
import { tmpDir } from './helpers.js';

const KEY = 'claude:YWJj';

test('停止意图落盘后可被读出', () => {
  const dir = tmpDir();
  writeIntent({ key: KEY, type: 'stop', turnId: 't1' }, { dir, now: 5 });
  const list = pendingIntents({ dir });
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'stop');
  assert.equal(list[0].turnId, 't1');
  assert.equal(list[0].key, KEY);
});

test('消费后不再出现', () => {
  const dir = tmpDir();
  writeIntent({ key: KEY, type: 'stop', turnId: 't1' }, { dir });
  consumeIntent(pendingIntents({ dir })[0], { dir });
  assert.deepEqual(pendingIntents({ dir }), []);
});

test('意图在守护进程重启后仍在（这就是不放内存的意义）', () => {
  const dir = tmpDir();
  writeIntent({ key: KEY, type: 'stop', turnId: 't1' }, { dir });
  // 换一个「进程」再读：意图作用于持久目标，不是内存句柄
  assert.equal(pendingIntents({ dir }).length, 1);
});

test('reconcileOrphans 把进程已消失的 running 轮次判为 aborted', () => {
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't1', agent: 'claude' }, { dir, now: 1 });
  writeIntent({ key: KEY, type: 'stop', turnId: 't1' }, { dir, now: 2 });
  const fixed = reconcileOrphans({ dir, isAlive: () => false, now: 3 });
  assert.equal(fixed.length, 1);
  const t = latestTurn(KEY, { dir });
  assert.equal(t.status, 'aborted');
  assert.ok(t.error, '要说明为什么变成 aborted');
  assert.equal(t.endedAt, 3);
  assert.equal(pendingIntents({ dir }).length, 0, '处理完的意图要清掉');
});

test('进程还活着时不动它', () => {
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't1', agent: 'claude' }, { dir, now: 1 });
  writeIntent({ key: KEY, type: 'stop', turnId: 't1' }, { dir, now: 2 });
  assert.deepEqual(reconcileOrphans({ dir, isAlive: () => true, now: 3 }), []);
  assert.equal(latestTurn(KEY, { dir }).status, 'running');
  assert.equal(pendingIntents({ dir }).length, 1, '意图留着给活进程去消费');
});

test('已结束的轮次不被 reconcile 改写', () => {
  const dir = tmpDir();
  startTurn({ key: KEY, turnId: 't1', agent: 'claude' }, { dir, now: 1 });
  writeIntent({ key: KEY, type: 'stop', turnId: 't1' }, { dir, now: 2 });
  reconcileOrphans({ dir, isAlive: () => false, now: 3 });
  const first = latestTurn(KEY, { dir });
  writeIntent({ key: KEY, type: 'stop', turnId: 't1' }, { dir, now: 4 });
  reconcileOrphans({ dir, isAlive: () => false, now: 5 });
  assert.equal(latestTurn(KEY, { dir }).endedAt, first.endedAt, '不得二次改写终态');
});

test('意图按创建时间升序返回', () => {
  const dir = tmpDir();
  writeIntent({ key: KEY, type: 'stop', turnId: 'b' }, { dir, now: 200 });
  writeIntent({ key: KEY, type: 'stop', turnId: 'a' }, { dir, now: 100 });
  assert.deepEqual(pendingIntents({ dir }).map((i) => i.turnId), ['a', 'b']);
});

// ── 停止端点 ───────────────────────────────────────

import { stopTurn } from '../src/http/handlers/turns.js';
import { openAsk, pendingAsk, cancelAsk } from '../src/ask/store.js';

const repoOk = { getSession: () => ({ key: KEY, agent: 'claude' }) };
const SEND_ON = { allowSend: true };
const runningOf = (...ids) => () => ids.map((turnId) => ({ turnId, status: 'running' }));
const noAsk = { pending: () => null, cancel: () => {} };

test('stopTurn 先落盘意图，有句柄时立刻杀进程并消费意图', () => {
  const written = [];
  const consumed = [];
  let killed = false;
  const live = new Map([['t1', { kill: () => { killed = true; } }]]);
  const r = stopTurn({
    repo: repoOk, config: SEND_ON, key: KEY, turnId: 't1', live, asks: noAsk,
    intents: { write: (i) => written.push(i), consume: (i) => consumed.push(i) },
    turns: { end: () => {}, list: runningOf('t1') },
  });
  assert.equal(r.status, 202);
  assert.equal(r.body.stopped, true);
  assert.equal(killed, true);
  assert.equal(written.length, 1, '意图必须先落盘——本进程随后崩掉也不能丢');
  assert.equal(live.has('t1'), false);
});

test('stopTurn 没有句柄时把意图留在盘上并说清后果', () => {
  const written = [];
  const r = stopTurn({
    repo: repoOk, config: SEND_ON, key: KEY, turnId: 'tX', live: new Map(), asks: noAsk,
    intents: { write: (i) => written.push(i), consume: () => {} },
    turns: { end: () => {}, list: runningOf('tX') },
  });
  assert.equal(r.status, 202);
  assert.equal(r.body.stopped, false);
  assert.match(r.body.note, /下次启动/);
  assert.equal(written.length, 1);
});

test('stopTurn 对未知会话与缺 turnId 给出可操作错误', () => {
  const noRepo = { getSession: () => null };
  assert.equal(stopTurn({ repo: noRepo, config: SEND_ON, key: KEY, turnId: 't1', live: new Map(), asks: noAsk, intents: { write: () => {}, consume: () => {} }, turns: { end: () => {}, list: runningOf('t1') } }).status, 404);
  const r = stopTurn({ repo: repoOk, config: SEND_ON, key: KEY, turnId: '', live: new Map(), asks: noAsk, intents: { write: () => {}, consume: () => {} }, turns: { end: () => {}, list: runningOf('t1') } });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.fix);
});

// ── 停止也是写操作，而且只能停这个会话自己的轮次（2026-10-01 审查）──────────

function stopWith(over) {
  const seen = { killed: false, written: 0, cancelled: 0 };
  const live = new Map([['t1', { kill: () => { seen.killed = true; } }]]);
  const r = stopTurn({
    repo: repoOk, config: SEND_ON, key: KEY, turnId: 't1', live,
    intents: { write: () => { seen.written += 1; }, consume: () => {} },
    turns: { end: () => {}, list: runningOf('t1') },
    asks: { pending: () => ({ turnId: 't1' }), cancel: () => { seen.cancelled += 1; } },
    ...over,
  });
  return { r, seen };
}

test('stopTurn：发送关着就不许停——它会杀进程，和发消息一样是写操作', () => {
  const { r, seen } = stopWith({ config: { allowSend: false } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'send_disabled');
  assert.deepEqual(seen, { killed: false, written: 0, cancelled: 0 });
});

test('stopTurn：turnId 不是这个会话的，一个都不动', () => {
  // 原来只看 turnId：传别的会话的 turnId，就杀了别人的进程、终态还记到这个会话下
  const { r, seen } = stopWith({ turns: { end: () => {}, list: runningOf('别的轮次') } });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'unknown_turn');
  assert.deepEqual(seen, { killed: false, written: 0, cancelled: 0 });
});

test('stopTurn：已经结束的轮次，不再写意图、不杀任何东西', () => {
  const { r, seen } = stopWith({ turns: { end: () => {}, list: () => [{ turnId: 't1', status: 'ok' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.stopped, false);
  assert.match(r.body.note, /已经结束/);
  assert.deepEqual(seen, { killed: false, written: 0, cancelled: 0 });
});

test('stopTurn：只撤这一轮自己问的那道题', () => {
  // 用真的问题存储：原来 stopTurn 不管三七二十一 cancelAsk(key)，
  // 传一个过期的 turnId 就会把当前这一轮正挂着的题撤掉
  const dir = tmpDir();
  openAsk({ key: KEY, turnId: '别的轮次', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }, { dir });
  const { seen } = stopWith({ asks: undefined });
  assert.equal(seen.killed, true);
  assert.equal(pendingAsk(KEY)?.turnId, '别的轮次', '别的轮次的题还得挂着');
  cancelAsk(KEY, '测试收尾', { dir });
});
