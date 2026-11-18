import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFollower } from '../src/follow.js';
import { resumeOffset, MAX_REPLAY_BYTES } from '../src/http/handlers/sessions.js';
import { tmpDir } from './helpers.js';

/**
 * 断线期间的事件不能丢。
 *
 * ## 为什么会丢
 *
 * follower 默认从**订阅那一刻的文件末尾**开始跟（`fromOffset ?? safeSize()`），
 * 断开期间写进 transcript 的东西它不会重发。两端的补救各有不足：
 *
 *   手机端  重连后 `resync()` 拉最近 50 条 —— 离线期间超过 50 个事件就有空洞
 *   网页端  用原生 EventSource，**重连后什么都不补** —— 全丢，要刷新页面才看得到
 *
 * 在这台机器的真实数据上量过（176 个会话、1918 轮）：单轮事件数中位 19、
 * P90 135、最大 1143，**27.5% 的轮次单轮就超过 50 个事件**。也就是说手机锁屏
 * 期间跑完一轮稍长的任务，四分之一以上的概率会丢一段；跨夜跨多轮基本必丢。
 * 这直接打在 v1 目标之三「手机上能看到 agent 的回复和执行过程」上。
 *
 * ## 修法：SSE 自己就有断点续传
 *
 * 服务端给每帧发 `id: <该帧结束时的字节偏移>`。浏览器原生 EventSource 断线
 * 重连时会**自动**带上 `Last-Event-ID`，所以网页端一行都不用改；手机端自己
 * 拼 SSE，重连时显式带上同一个头。
 *
 * transcript 是只追加的（`/compact` 也是追加，不重写），所以字节偏移是稳的。
 */

const assistant = (i) => JSON.stringify({
  type: 'assistant', uuid: `a${i}`, isSidechain: false,
  message: { role: 'assistant', content: [{ type: 'text', text: `第 ${i} 条` }] },
});

function setup(n = 1) {
  const file = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(file, Array.from({ length: n }, (_, i) => assistant(i)).join('\n') + '\n');
  return { file, agent: 'claude' };
}

/* ── 解析客户端给的续传位置 ──────────────────────────────────────────────── */

test('Last-Event-ID 优先于 ?from=，两者都认', () => {
  const size = 1000;
  assert.equal(resumeOffset({ header: '120', query: '300', size }).from, 120, '头优先');
  assert.equal(resumeOffset({ header: null, query: '300', size }).from, 300, '没有头就用 query');
  assert.equal(resumeOffset({ header: '', query: null, size }).from, null, '都没有 = 从末尾开始');
});

test('看不懂的偏移一律当没给，而不是从 0 重放整个文件', () => {
  const size = 1000;
  for (const bad of ['abc', '-5', '1.5', 'NaN', 'Infinity', '0x10', ' ']) {
    assert.equal(resumeOffset({ header: bad, query: null, size }).from, null, `${bad} 该被忽略`);
  }
});

test('偏移超出文件末尾：当没给', () => {
  // 会话被换过/截断过，旧偏移解释不了。重放会错位，不如从末尾开始。
  assert.equal(resumeOffset({ header: '2000', query: null, size: 1000 }).from, null);
});

test('偏移 0 是合法的——那是「从头开始」，不是「没给」', () => {
  const r = resumeOffset({ header: '0', query: null, size: 500 });
  assert.equal(r.from, 0);
  assert.equal(r.clamped, false);
});

test('空洞太大就夹到上限，并说清被夹过', () => {
  const size = MAX_REPLAY_BYTES * 3;
  const r = resumeOffset({ header: '0', query: null, size });
  assert.equal(r.clamped, true, '离开一周回来不该重放整个 transcript');
  assert.equal(r.from, size - MAX_REPLAY_BYTES);

  // 刚好在上限之内不夹
  const ok = resumeOffset({ header: String(size - MAX_REPLAY_BYTES), query: null, size });
  assert.equal(ok.clamped, false);
});

/* ── follower 按给定偏移重放 ─────────────────────────────────────────────── */

test('从给定偏移重放断线期间写入的事件', () => {
  const m = setup(1);
  const mark = fs.statSync(m.file).size; // 客户端断开时看到的位置

  // 断线期间又写了 3 条
  for (let i = 1; i <= 3; i += 1) fs.appendFileSync(m.file, assistant(i) + '\n');

  const got = [];
  const f = createFollower(m, (evs) => got.push(...evs), { fromOffset: mark });
  f.tick();
  assert.equal(got.length, 3, '断线期间那三条都要补上');
  assert.deepEqual(got.map((e) => e.text), ['第 1 条', '第 2 条', '第 3 条']);
});

test('重放不重复：客户端给的偏移是精确行边界，首行不能丢', () => {
  const m = setup(1);
  const mark = fs.statSync(m.file).size;
  fs.appendFileSync(m.file, assistant(1) + '\n');

  const got = [];
  createFollower(m, (evs) => got.push(...evs), { fromOffset: mark }).tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '第 1 条', '正好从边界开始，那一条不能被当成半行裁掉');
});

test('被夹过的起点落在行中间时，丢掉那半行——只丢第一次读', () => {
  const m = setup(3);
  const size = fs.statSync(m.file).size;

  const got = [];
  // 故意给一个行中间的位置（模拟夹到上限之后的起点）
  const f = createFollower(m, (evs) => got.push(...evs), {
    fromOffset: size - 10, alignFirstRead: true,
  });
  f.tick();
  assert.equal(got.length, 0, '半行被丢掉，不该产出半个事件');

  // 之后的追加照常推——对齐只作用于第一次读
  fs.appendFileSync(m.file, assistant(9) + '\n');
  f.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '第 9 条');
});

test('事件带着自己的字节偏移出网——客户端靠它记住断点', () => {
  const m = setup(1);
  const mark = fs.statSync(m.file).size;
  fs.appendFileSync(m.file, assistant(1) + '\n');

  const got = [];
  createFollower(m, (evs) => got.push(...evs), { fromOffset: mark }).tick();
  assert.equal(got[0].offset, mark, 'offset 必须是这条记录在文件里的起点');
});
