import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFollower } from '../src/follow.js';
import { tmpDir } from './helpers.js';

const assistant = (i) => JSON.stringify({
  type: 'assistant', uuid: `a${i}`, isSidechain: false,
  message: { role: 'assistant', content: [{ type: 'text', text: `第 ${i} 条` }] },
});

function setup() {
  const file = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(file, assistant(0) + '\n');
  return { file, agent: 'claude' };
}

test('默认从文件末尾开始，不重放历史', () => {
  const m = setup();
  const got = [];
  const f = createFollower(m, (evs) => got.push(...evs));
  f.tick();
  assert.equal(got.length, 0, '已有内容不得作为新事件推送');
});

test('追加后推出新事件', () => {
  const m = setup();
  const got = [];
  const f = createFollower(m, (evs) => got.push(...evs));
  f.tick();
  fs.appendFileSync(m.file, assistant(1) + '\n');
  f.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '第 1 条');
});

test('半行不推送，补齐换行后才推', () => {
  const m = setup();
  const got = [];
  const f = createFollower(m, (evs) => got.push(...evs));
  f.tick();
  const line = assistant(2);
  fs.appendFileSync(m.file, line.slice(0, 20));
  f.tick();
  assert.equal(got.length, 0, '半行必须留在缓冲区外，不得产生半个事件');
  fs.appendFileSync(m.file, line.slice(20) + '\n');
  f.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '第 2 条');
});

test('已换行的回复先推送，后面的半个 UTF-8 字符等下次续写', () => {
  const m = setup();
  const got = [];
  const f = createFollower(m, (events) => got.push(...events));
  const first = Buffer.from(assistant(1) + '\r\n');
  const second = Buffer.from(assistant(2) + '\n');
  const cut = second.indexOf(Buffer.from('第')) + 1;
  const mark = f.offset + first.length;
  fs.appendFileSync(m.file, Buffer.concat([first, second.subarray(0, cut)]));
  f.tick();
  assert.deepEqual(got.map((e) => e.text), ['第 1 条']);
  assert.equal(f.offset, mark);
  f.tick();
  fs.appendFileSync(m.file, second.subarray(cut));
  f.tick();
  assert.deepEqual(got.map((e) => e.text), ['第 1 条', '第 2 条']);
  assert.equal(f.offset, fs.statSync(m.file).size);
});

test('文件被截断时偏移回退到新的文件末尾且不抛异常', () => {
  const m = setup();
  const got = [];
  const f = createFollower(m, (evs) => got.push(...evs));
  f.tick();
  fs.writeFileSync(m.file, assistant(9) + '\n');
  assert.doesNotThrow(() => f.tick());
  assert.ok(f.offset <= fs.statSync(m.file).size);
});

test('fromOffset 为 0 时重放全部历史', () => {
  const m = setup();
  const got = [];
  const f = createFollower(m, (evs) => got.push(...evs), { fromOffset: 0 });
  f.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '第 0 条');
});

test('start/stop 可反复调用而不泄漏定时器', () => {
  const m = setup();
  const f = createFollower(m, () => {}, { intervalMs: 10 });
  f.start(); f.start(); f.stop(); f.stop();
  assert.ok(true);
});
