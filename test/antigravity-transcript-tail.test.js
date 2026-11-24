import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir, writeJsonl } from './helpers.js';

const user = (step_index, content) => ({ step_index, type: 'USER_INPUT', content });
const done = (step_index) => ({ step_index, type: 'PLANNER_RESPONSE', status: 'DONE', content: '完成' });

test('桌面游标只读新增字节，跳过基线半行及超长行，跟随截断和轮转且不重播旧终态', async (t) => {
  const { TranscriptCursor } = await import('../src/agent/antigravityStream.js');
  const root = tmpDir();
  const file = writeJsonl(root, 'transcript.jsonl', Array.from({ length: 8000 }, (_, i) => done(i)));
  const partial = Buffer.from(JSON.stringify(user(8000, '前一轮未写完')));
  fs.appendFileSync(file, partial.subarray(0, -2));
  const original = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, 'readSync', (...args) => { const n = original(...args); bytes += n; return n; });
  const cursor = new TranscriptCursor({ maxLineBytes: 512, batchBytes: 150 });
  await cursor.skipExisting(file);
  const seen = [];
  const poll = () => {
    let caughtUp;
    do { caughtUp = cursor.read(file, (record) => seen.push(record)); } while (!caughtUp);
  };
  const row = Buffer.from(JSON.stringify(user(8001, '分块中文')));
  const split = row.indexOf(Buffer.from('中')) + 1;
  fs.appendFileSync(file, Buffer.concat([partial.subarray(-2), Buffer.from('\n'), row.subarray(0, split)]));
  poll();
  assert.deepEqual(seen, []);
  fs.appendFileSync(file, Buffer.concat([row.subarray(split), Buffer.from('\n')]));
  fs.appendFileSync(file, Buffer.from(JSON.stringify({ step_index: 8002, type: 'GENERIC', content: '长'.repeat(300) }) + '\n'));
  poll();
  assert.deepEqual(seen, [user(8001, '分块中文')]);
  const afterUpdate = bytes;
  for (let i = 0; i < 10; i++) poll();
  assert.equal(bytes, afterUpdate, '没有新增字节的轮询不读取日志正文');
  assert.ok(bytes < 96 * 1024, '建立基线也不通读完整历史');
  fs.renameSync(file, path.join(root, 'rotated.jsonl'));
  fs.writeFileSync(file, [done(7999), user(8001, '分块中文'), done(8003)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  poll();
  assert.deepEqual(seen.at(-1), done(8003));
  assert.equal(seen.length, 2);
  fs.writeFileSync(file, JSON.stringify(done(8004)) + '\n');
  poll();
  assert.deepEqual(seen.at(-1), done(8004));
  assert.equal(seen.length, 3);
});

test('末尾有很长的旧半行时分批建立基线，第一条真正新增的记录正常送达', async () => {
  const { TranscriptCursor } = await import('../src/agent/antigravityStream.js');
  const root = tmpDir();
  const file = writeJsonl(root, 'transcript.jsonl', [done(99)]);
  fs.appendFileSync(file, Buffer.alloc(3 * 1024 * 1024, 32));
  const cursor = new TranscriptCursor({ maxLineBytes: 512 });
  let yielded = false;
  setImmediate(() => { yielded = true; });
  await cursor.skipExisting(file);
  assert.equal(yielded, true);
  assert.equal(cursor.highest, 99);
  fs.appendFileSync(file, '\n' + JSON.stringify(user(100, '继续')) + '\n');
  const records = [];
  cursor.read(file, (record) => records.push(record));
  assert.deepEqual(records, [user(100, '继续')]);
});
