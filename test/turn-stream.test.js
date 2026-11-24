import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { streamSession, listSessions, sessionState } from '../src/http/handlers/sessions.js';
import { createRepo } from '../src/repo.js';
import { startTurn, updateTurnControl, endTurn } from '../src/runtime/turns.js';
import { listenerCount } from '../src/runtime/bus.js';
import { enqueue, takeNext } from '../src/runtime/queue.js';
import { tmpDir, writeJsonl } from './helpers.js';

// 这一整个文件守的是同一件事：**Claude 的 transcript 里没有轮次终态记录**
// （实测 claude events=1782 turn_end=0 / codex events=1919 turn_end=42）。
// 终态只存在于 ~/.baton/runs/*.json。原先 streamSession 只挂 transcript follower，
// 于是 Claude 会话的运行轴永远停在「进行中」——就是 Baton 立项要消灭的
// 「永远 Thinking」换了个成因。

function fakeRes() {
  const handlers = {};
  return {
    chunks: [],
    writeHead() {},
    write(s) { this.chunks.push(s); return true; },
    end() {},
    on(ev, fn) { handlers[ev] = fn; },
    fire(ev) { handlers[ev]?.(); },
    get text() { return this.chunks.join(''); },
    events() {
      const out = [];
      for (const m of this.text.matchAll(/event: (\w+)\ndata: (.+)\n\n/g)) {
        out.push({ type: m[1], data: JSON.parse(m[2]) });
      }
      return out;
    },
  };
}

// key 由 transcript 的**相对**路径编码而来，而 BATON_DIR（轮次记录）是整个测试进程
// 共享的——两个 boot() 用同一个文件名就会共用同一个 key，上一个测试的轮次记录会漏到
// 下一个测试里。所以每个测试必须要一个自己的 id。
let seq = 0;

function boot() {
  const claudeRoot = tmpDir();
  seq += 1;
  const OWN = `aaaaaaaa-0000-0000-0000-${String(seq).padStart(12, '0')}`;
  writeJsonl(claudeRoot, path.join('C--proj', `${OWN}.jsonl`), [
    { type: 'user', sessionId: OWN, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '第一句' } },
  ]);
  const repo = createRepo({
    claudeRoot, codexRoot: tmpDir(), registryRoot: tmpDir(), codexStateFile: null,
  });
  const key = repo.listChains()[0].members[0].key;
  return { repo, key };
}

test('轮次开始与结束都通过 SSE 送达（Claude 的 transcript 给不了这个）', () => {
  const { repo, key } = boot();
  const res = fakeRes();
  assert.equal(streamSession(repo, key, res), null, 'SSE 接管后不该再返回响应体');

  startTurn({ key, turnId: 'T1', agent: 'claude' });
  endTurn({ key, turnId: 'T1', status: 'ok', tokens: { out: 10 }, eventCount: 3 });

  const types = res.events().map((e) => e.type);
  assert.deepEqual(types, ['turn_start', 'turn_end']);

  const end = res.events()[1].data;
  assert.equal(end.status, 'ok');
  assert.equal(end.turnId, 'T1');
  assert.ok(end.endedAt, '终态必须带结束时刻，否则客户端算不出总耗时');
  res.fire('close');
});

test('恢复和去重资料只保存在本机，状态与 SSE 仍提供正常停止信息', () => {
  const { repo, key } = boot();
  const res = fakeRes();
  streamSession(repo, key, res);
  startTurn({ key, turnId: 'private', agent: 'claude', principalId: 'owner', request: { id: 'test', signature: 'digest' } });
  updateTurnControl(key, 'private', { ownerId: 'instance', ownerPid: 123, childPid: 456, childStarted: 'test:birth', childGroup: 456, principalGeneration: 'g',
    monitor: { baselineStep: 7 }, canStop: false });
  const snapshot = sessionState({ repo, key, live: () => new Map() }).body.latestTurn;
  for (const value of [snapshot, ...res.events().map((e) => e.data)]) {
    for (const field of ['ownerId', 'ownerPid', 'childPid', 'childStarted', 'childGroup', 'monitor', 'request', 'principalId', 'principalGeneration']) {
      assert.equal(field in value, false, field);
    }
  }
  assert.equal(snapshot.canStop, false);
  endTurn({ key, turnId: 'private', status: 'ok', eventCount: 1 });
  res.fire('close');
});

test('超过回放上限的未完成尾行不会触发反复补页，完成后继续同一条流', async (t) => {
  const { repo, key } = boot();
  const file = repo.getSession(key).file;
  const from = fs.statSync(file).size;
  fs.appendFileSync(file, Buffer.alloc(5 * 1024 * 1024, 0x20));
  const res = fakeRes();
  streamSession(repo, key, res, { resume: { query: String(from) } });
  t.after(() => res.fire('close'));
  await delay(150);
  assert.ok(!res.events().some((e) => e.type === 'gap'));
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'tail', message: { role: 'user', content: '完整回复' } }) + '\n');
  for (let i = 0; i < 30 && !res.events().some((e) => e.type === 'events'); i++) await delay(100);
  assert.ok(res.events().some((e) => e.data.events?.some((item) => item.text === '完整回复')));
});

test('终态不会被重复播送——否则停止后秒表会跳一下', () => {
  const { repo, key } = boot();
  const res = fakeRes();
  streamSession(repo, key, res);

  startTurn({ key, turnId: 'T2', agent: 'claude' });
  endTurn({ key, turnId: 'T2', status: 'aborted', error: '用户停止', tokens: null, eventCount: 0 });
  // 进程自己的 .then() 随后还会跑一遍 endTurn，被终态守卫挡住，不该再发一帧
  endTurn({ key, turnId: 'T2', status: 'ok', tokens: { out: 5 }, eventCount: 2 });

  const ends = res.events().filter((e) => e.type === 'turn_end');
  assert.equal(ends.length, 1, '一轮只能有一个 turn_end');
  assert.equal(ends[0].data.status, 'aborted', '「已停止」不得被覆盖成「正常完成」');
  res.fire('close');
});

test('停止请求通过 SSE 和重连快照可见，确认退出之前心跳仍为运行中', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { repo, key } = boot();
  const live = fakeRes();
  streamSession(repo, key, live);
  startTurn({ key, turnId: 'waiting-for-close', agent: 'claude' });
  updateTurnControl(key, 'waiting-for-close', { stopReason: '用户停止' });
  const frames = live.events();
  assert.deepEqual(frames.map((frame) => frame.type), ['turn_start', 'turn_control']);
  assert.equal(frames[1].data.status, 'running');
  live.fire('close');

  const reconnected = fakeRes();
  streamSession(repo, key, reconnected);
  assert.equal(reconnected.events()[0].data.stopReason, '用户停止');
  t.mock.timers.tick(15_000);
  assert.equal(reconnected.events().at(-1).data.running, true);
  assert.equal(reconnected.events().at(-1).data.stopping, true);
  endTurn({ key, turnId: 'waiting-for-close', status: 'failed' });
  assert.equal(reconnected.events().at(-1).data.status, 'aborted');
  reconnected.fire('close');
});

test('建流即补一帧当前轮次——手机重连后不能等到下次状态变化才知道在跑什么', () => {
  const { repo, key } = boot();
  startTurn({ key, turnId: 'T3', agent: 'claude' }); // 断连期间起的轮次

  const res = fakeRes();
  streamSession(repo, key, res);

  const first = res.events()[0];
  assert.equal(first.type, 'turn_start');
  assert.equal(first.data.turnId, 'T3');
  assert.equal(first.data.status, 'running');
  res.fire('close');
});

test('心跳带上已运行秒数，且以服务器时间为准', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { repo, key } = boot();
  const res = fakeRes();
  let clock = 1_000_000;
  streamSession(repo, key, res, { now: () => clock });

  startTurn({ key, turnId: 'T4', agent: 'claude' }, { now: clock });
  clock += 42_000;
  t.mock.timers.tick(15_000);

  const tick = res.events().find((e) => e.type === 'tick');
  assert.ok(tick, '心跳周期到了必须有 tick');
  assert.equal(tick.data.turnId, 'T4');
  assert.equal(tick.data.running, true);
  assert.equal(tick.data.elapsedMs, 42_000, '秒表的权威是服务器，不是手机自己数的');

  // 轮次结束后秒表要停，否则客户端会一直数下去
  endTurn({ key, turnId: 'T4', status: 'ok', tokens: null, eventCount: 1 }, { now: clock });
  clock += 10_000;
  t.mock.timers.tick(15_000);

  const last = res.events().filter((e) => e.type === 'tick').at(-1);
  assert.equal(last.data.running, false);
  assert.equal(last.data.elapsedMs, 0, '轮次结束后不再累加');
  res.fire('close');
});

test('流关闭后必须退订，否则每次重连都泄漏一个订阅者', () => {
  const { repo, key } = boot();
  const before = listenerCount(key);
  const res = fakeRes();
  streamSession(repo, key, res);
  assert.equal(listenerCount(key), before + 1);
  res.fire('close');
  assert.equal(listenerCount(key), before, '关闭后订阅者数必须回到原值');
});

test('别的会话的轮次不会串台', () => {
  const { repo, key } = boot();
  const res = fakeRes();
  streamSession(repo, key, res);

  startTurn({ key: 'claude:另一个会话', turnId: 'X1', agent: 'claude' });
  endTurn({ key: 'claude:另一个会话', turnId: 'X1', status: 'ok', tokens: null, eventCount: 1 });

  assert.deepEqual(res.events(), [], '订阅按 key 隔离');
  res.fire('close');
});

test('心跳捎上排队条数——队列没有自己的事件通道，不捎就永远看不见别处排的', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { repo, key } = boot();
  const res = fakeRes();
  streamSession(repo, key, res);

  t.mock.timers.tick(15_000);
  assert.equal(res.events().find((e) => e.type === 'tick').data.queued, 0);

  enqueue({ key, text: '在别处排的一条' });
  t.mock.timers.tick(15_000);
  const last = res.events().filter((e) => e.type === 'tick').at(-1);
  assert.equal(last.data.queued, 1, '心跳必须反映盘上的真实队列');

  takeNext(key);
  t.mock.timers.tick(15_000);
  assert.equal(res.events().filter((e) => e.type === 'tick').at(-1).data.queued, 0,
    '排空后要自动回正——某个 turn_end 漏了也不该一直挂着');
  res.fire('close');
});

test('列表带出运行态——那是列表里唯一的状态表达', () => {
  // 一行只有圆点和标题，没有任何状态文字，所以「在跑」全靠这个字段。
  // 用内存集合而不是读轮次记录：读记录是上百次 IO，而且守护进程中途挂掉时
  // 记录会永远停在 running，反而不如内存准。
  const { repo, key } = boot();

  const before = listSessions(repo).chains[0].members[0];
  assert.equal(before.running, false);

  startTurn({ key, turnId: 'R1', agent: 'claude' });
  assert.equal(listSessions(repo).chains[0].members[0].running, true);

  endTurn({ key, turnId: 'R1', status: 'ok', tokens: null, eventCount: 1 });
  assert.equal(listSessions(repo).chains[0].members[0].running, false, '结束后要落回去');
});

test('别的会话在跑不会让这个也亮起来', () => {
  const { repo } = boot();
  startTurn({ key: 'claude:别人', turnId: 'X', agent: 'claude' });
  assert.equal(listSessions(repo).chains[0].members[0].running, false);
  endTurn({ key: 'claude:别人', turnId: 'X', status: 'ok', tokens: null, eventCount: 1 });
});

/*
  电脑上在跑的那些也要亮——owner 2026-10-08：「我刚刚下班，打开手机，就看不到
  哪些会话是还在工作的」。信号来自 CLI 自己的进程登记（runtime/live.js），
  这里只测「列表怎么把它和 Baton 自己那份合起来」。
*/
test('电脑上在跑的会话，列表里也算在跑', () => {
  const { repo } = boot();
  const m = listSessions(repo).chains[0].members[0];
  assert.equal(m.running, false);
  assert.equal(m.waiting, false);

  const live = new Map([[m.providerId, 'busy']]);
  assert.equal(listSessions(repo, { live }).chains[0].members[0].running, true);
});

test('卡在等人点确认的，是另一种状态，不混进「在跑」', () => {
  const { repo } = boot();
  const m0 = listSessions(repo).chains[0].members[0];
  const m = listSessions(repo, { live: new Map([[m0.providerId, 'waiting']]) }).chains[0].members[0];
  assert.equal(m.waiting, true);
  assert.equal(m.running, false, '「等你」不是「在跑」——一个是等它，一个是等你');
});

test('两边同时成立时按在跑算', () => {
  const { repo, key } = boot();
  startTurn({ key, turnId: 'R9', agent: 'claude' });
  const m0 = listSessions(repo).chains[0].members[0];
  const m = listSessions(repo, { live: new Map([[m0.providerId, 'waiting']]) }).chains[0].members[0];
  assert.equal(m.running, true);
  assert.equal(m.waiting, false);
  endTurn({ key, turnId: 'R9', status: 'ok', tokens: null, eventCount: 1 });
});

test('别的会话在电脑上跑，不会让这条亮起来', () => {
  const { repo } = boot();
  const live = new Map([['99999999-0000-4000-8000-000000000099', 'busy']]);
  assert.equal(listSessions(repo, { live }).chains[0].members[0].running, false);
});
