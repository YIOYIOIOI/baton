import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readHead, readTail, readRange, readRangeWithOffsets, scanForward, parseLines } from '../src/jsonl.js';
import { tmpDir, writeJsonl } from './helpers.js';

test('readHead 读到全部行且未截断', () => {
  const f = writeJsonl(tmpDir(), 'a.jsonl', [{ i: 1 }, { i: 2 }, { i: 3 }]);
  const { lines, truncated } = readHead(f);
  assert.equal(lines.length, 3);
  assert.equal(truncated, false);
});

test('readHead 超窗时丢弃末尾可能被截断的行', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'big.jsonl');
  const line = JSON.stringify({ pad: 'x'.repeat(1000) });
  fs.writeFileSync(f, Array.from({ length: 200 }, () => line).join('\n') + '\n');
  const { lines, truncated } = readHead(f, 4096);
  assert.equal(truncated, true);
  assert.ok(lines.length >= 1 && lines.length <= 4, `期望少量整行，实得 ${lines.length}`);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), '每一行都必须是完整 JSON');
});

test('readTail 丢弃首行不完整片段并给出可用的 startOffset', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'big.jsonl');
  const line = JSON.stringify({ pad: 'y'.repeat(1000) });
  fs.writeFileSync(f, Array.from({ length: 200 }, () => line).join('\n') + '\n');
  const { lines, startOffset } = readTail(f, 4096);
  assert.ok(startOffset > 0);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
  const { lines: again } = readRange(f, startOffset, startOffset + 4096);
  assert.doesNotThrow(() => JSON.parse(again[0]));
});

test('readTail 小文件时 startOffset 为 0 且保留首行', () => {
  const f = writeJsonl(tmpDir(), 'a.jsonl', [{ i: 1 }, { i: 2 }]);
  const { lines, startOffset } = readTail(f);
  assert.equal(startOffset, 0);
  assert.equal(lines.length, 2);
});

test('scanForward 找到首个命中行', () => {
  const f = writeJsonl(tmpDir(), 'a.jsonl', [{ t: 'x' }, { t: 'want' }, { t: 'z' }]);
  const hit = scanForward(f, (l) => l.includes('"want"'));
  assert.ok(hit);
  assert.equal(JSON.parse(hit).t, 'want');
});

test('scanForward 超出字节上限时返回 null', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'big.jsonl');
  const line = JSON.stringify({ pad: 'z'.repeat(1000) });
  fs.writeFileSync(f, Array.from({ length: 500 }, () => line).join('\n') + '\n');
  assert.equal(scanForward(f, (l) => l.includes('"never"'), 8192), null);
});

test('readRangeWithOffsets 默认丢首行，trimPartialFirstLine:false 时不丢', () => {
  const f = writeJsonl(tmpDir(), 'a.jsonl', [{ i: 1 }, { i: 2 }, { i: 3 }]);
  const size = fs.statSync(f).size;
  const firstLineEnd = Buffer.byteLength(JSON.stringify({ i: 1 }), 'utf8') + 1;

  // 向后分页：start 是任意位置，左边缘可能切断一行，必须丢首行
  const trimmed = readRangeWithOffsets(f, firstLineEnd, size);
  assert.deepEqual(trimmed.entries.map((e) => JSON.parse(e.line).i), [3]);

  // tail-follow：start 是精确行边界，丢首行会把新追加的内容吃掉
  const kept = readRangeWithOffsets(f, firstLineEnd, size, { trimPartialFirstLine: false });
  assert.deepEqual(kept.entries.map((e) => JSON.parse(e.line).i), [2, 3]);
  assert.equal(kept.entries[0].offset, firstLineEnd, '偏移必须仍然指向行首');
});

test('parseLines 跳过坏行而不抛异常', () => {
  assert.deepEqual(parseLines(['{"a":1}', 'not json', '', '{"b":2}']), [{ a: 1 }, { b: 2 }]);
});
