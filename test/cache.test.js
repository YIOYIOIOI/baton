import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeadCache, createTailCache } from '../src/cache.js';

test('头部缓存在文件追加后仍然命中', () => {
  const c = createHeadCache();
  c.set('/f.jsonl', 1000, { parentId: 'p' });
  assert.deepEqual(c.get('/f.jsonl', 5000), { parentId: 'p' }, 'append-only 文件的头不变，追加不得使其失效');
});

test('头部缓存在 size 变小时失效', () => {
  const c = createHeadCache();
  c.set('/f.jsonl', 1000, { parentId: 'p' });
  assert.equal(c.get('/f.jsonl', 500), undefined, '文件被截断或替换过');
});

test('头部缓存未命中的文件返回 undefined', () => {
  assert.equal(createHeadCache().get('/nope', 10), undefined);
});

test('尾部缓存 size 或 mtime 任一变化即失效', () => {
  const c = createTailCache();
  c.set('/f.jsonl', 1000, 111, { customTitle: 't' });
  assert.deepEqual(c.get('/f.jsonl', 1000, 111), { customTitle: 't' });
  assert.equal(c.get('/f.jsonl', 1001, 111), undefined);
  assert.equal(c.get('/f.jsonl', 1000, 222), undefined);
});

test('缓存可容纳多个文件互不干扰', () => {
  const c = createTailCache();
  c.set('/a', 1, 1, 'A');
  c.set('/b', 2, 2, 'B');
  assert.equal(c.get('/a', 1, 1), 'A');
  assert.equal(c.get('/b', 2, 2), 'B');
  assert.equal(c.size, 2);
});
