import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pageEvents } from '../src/paginate.js';
import { readRangeWithOffsets } from '../src/jsonl.js';
import { tmpDir } from './helpers.js';

function claudeFile(n) {
  const dir = tmpDir();
  const file = path.join(dir, 's.jsonl');
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `a${i}`, timestamp: `2026-09-08T00:00:${String(i % 60).padStart(2, '0')}Z`,
      isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `第 ${i} 条` }] },
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { file, agent: 'claude', size: fs.statSync(file).size };
}

test('readRangeWithOffsets 给出的偏移能定位到行首', () => {
  const m = claudeFile(50);
  const { entries, hitStart } = readRangeWithOffsets(m.file, 0, m.size);
  assert.equal(hitStart, true);
  assert.equal(entries.length, 50);
  const third = entries[3];
  const buf = Buffer.alloc(200);
  const fd = fs.openSync(m.file, 'r');
  fs.readSync(fd, buf, 0, 200, third.offset);
  fs.closeSync(fd);
  assert.ok(buf.toString('utf8').startsWith(third.line.slice(0, 30)));
});

test('首页返回最后 limit 条，顺序为时间升序', async () => {
  const m = claudeFile(200);
  const { events, nextBefore } = await pageEvents(m, { limit: 10 });
  assert.equal(events.length, 10);
  assert.equal(events[0].text, '第 190 条');
  assert.equal(events[9].text, '第 199 条');
  assert.ok(typeof nextBefore === 'number' && nextBefore > 0);
});

test('首屏的 endOffset 与已完成的记录一致，包含空行，未换行的 JSON 留给实时流', async () => {
  const m = claudeFile(3);
  const pending = JSON.stringify({
    type: 'assistant', uuid: 'pending', message: { role: 'assistant', content: [{ type: 'text', text: '追加' }] },
  });
  fs.appendFileSync(m.file, '\r\n' + pending);
  const page = await pageEvents(m);
  assert.equal(page.endOffset, m.size + 2);
  assert.deepEqual(page.events.map((e) => e.text), ['第 0 条', '第 1 条', '第 2 条']);
  fs.writeFileSync(m.file, pending);
  assert.deepEqual(await pageEvents(m), { events: [], nextBefore: null, endOffset: 0 });
});

test('跨过大段未完成行查找已完成游标时可以处理其他请求', async () => {
  const m = claudeFile(1);
  fs.appendFileSync(m.file, Buffer.alloc(9 * 1024 * 1024, 0x78));
  let yielded = false;
  const scheduled = new Promise((resolve) => setImmediate(() => { yielded = true; resolve(); }));
  const page = await pageEvents(m);
  assert.equal(page.endOffset, m.size);
  assert.equal(yielded, true);
  await scheduled;
});

test('用 nextBefore 翻上一页且不重不漏', async () => {
  const m = claudeFile(200);
  const p1 = await pageEvents(m, { limit: 10 });
  const p2 = await pageEvents(m, { limit: 10, before: p1.nextBefore });
  assert.equal(p2.events.at(-1).text, '第 189 条', '上一页应紧接首页之前');
  assert.equal(p2.events[0].text, '第 180 条');
  const ids = new Set([...p1.events, ...p2.events].map((e) => e.id));
  assert.equal(ids.size, 20, '两页事件不得重叠');
});

test('一行拆出几条事件、页界正好切在这一行中间：往前翻不丢这一行前半截', async () => {
  // 一条 assistant 记录先说一句、再并排调两个工具 → 一行三条事件（同一行偏移）。
  // 原来页界切在行中间时，nextBefore 指向这一行的行首，下一页只读它之前的行——
  // 这一行前半截的事件两页都不给，往上翻历史时悄悄少了几条
  const dir = tmpDir();
  const file = path.join(dir, 'multi.jsonl');
  const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({
    type: 'assistant', uuid: `m${i}`, timestamp: '2026-11-07T00:00:00Z', isSidechain: false,
    message: { role: 'assistant', content: [
      { type: 'text', text: `第 ${i} 行` },
      { type: 'tool_use', id: `t${i}a`, name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: `t${i}b`, name: 'Bash', input: { command: 'pwd' } },
    ] },
  }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const m = { file, agent: 'claude', size: fs.statSync(file).size };

  const all = (await pageEvents(m, { limit: 500 })).events.map((e) => e.id);
  assert.equal(all.length, 60);
  const got = [];
  let before = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const p = await pageEvents(m, { limit: 10, before });
    got.unshift(...p.events.map((e) => e.id));
    if (p.nextBefore === null) break;
    before = p.nextBefore;
  }
  assert.deepEqual(got, all, '一页页往前翻，拼起来要和一次读全的一模一样：不丢、不重、顺序不乱');
});

test('翻到文件头时 nextBefore 为 null', async () => {
  const m = claudeFile(5);
  const { events, nextBefore } = await pageEvents(m, { limit: 50 });
  assert.equal(events.length, 5);
  assert.equal(nextBefore, null);
});

test('恰好剩一整页时也是 null：不让客户端多翻一次空页', async () => {
  const m = claudeFile(10);
  const { events, nextBefore } = await pageEvents(m, { limit: 10 });
  assert.equal(events.length, 10);
  assert.equal(nextBefore, null);
});

test('事件稀疏时窗口翻倍直到取够或触顶', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sparse.jsonl');
  const noise = JSON.stringify({ type: 'attachment', uuid: 'n', attachment: { pad: 'x'.repeat(3000) } });
  const real = JSON.stringify({
    type: 'assistant', uuid: 'r1', isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text: '真实事件' }] },
  });
  fs.writeFileSync(file, [...Array.from({ length: 300 }, () => noise), real].join('\n') + '\n');
  const m = { file, agent: 'claude', size: fs.statSync(file).size };
  const { events } = await pageEvents(m, { limit: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0].text, '真实事件');
});

test('窗口不得超过 8MB 上限', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'huge.jsonl');
  const noise = JSON.stringify({ type: 'attachment', uuid: 'n', attachment: { pad: 'x'.repeat(10000) } });
  fs.writeFileSync(file, Array.from({ length: 1200 }, () => noise).join('\n') + '\n');
  const m = { file, agent: 'claude', size: fs.statSync(file).size };
  const t0 = Date.now();
  const { events } = await pageEvents(m, { limit: 10 });
  assert.equal(events.length, 0);
  assert.ok(Date.now() - t0 < 5000, '触顶即停，不得退化成全扫');
});
