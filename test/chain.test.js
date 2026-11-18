import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChains } from '../src/chain.js';

const s = (providerId, parentId, mtimeMs, agent = 'claude') =>
  ({ key: `${agent}:${providerId}`, agent, providerId, parentId, firstTs: null, mtimeMs });

test('自根会话各成一条链', () => {
  const chains = buildChains([s('a', null, 100), s('b', null, 200)]);
  assert.equal(chains.length, 2);
  assert.equal(chains[0].chainKey, 'b', '按最后活动降序');
  assert.equal(chains[0].members.length, 1);
});

test('同一父指针的三个子代聚为一条链', () => {
  const chains = buildChains([
    s('17a80b9b', '4ed16f8e', 300),
    s('5e3dc0d0', '4ed16f8e', 400),
    s('912ea203', '4ed16f8e', 500),
  ]);
  assert.equal(chains.length, 1, '父文件缺失也不得拆成三条链');
  assert.equal(chains[0].chainKey, '4ed16f8e');
  assert.equal(chains[0].members.length, 3);
  assert.equal(chains[0].lastActivityMs, 500);
});

test('父文件存在时链根是父自己', () => {
  const chains = buildChains([s('4ed16f8e', null, 100), s('17a80b9b', '4ed16f8e', 300)]);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].chainKey, '4ed16f8e');
  assert.equal(chains[0].members.length, 2);
});

test('多级上溯到最深祖先', () => {
  const chains = buildChains([s('c', 'b', 300), s('b', 'a', 200), s('a', null, 100)]);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].chainKey, 'a');
  assert.equal(chains[0].members.length, 3);
});

test('成环时就地停止不死循环', () => {
  const chains = buildChains([s('x', 'y', 100), s('y', 'x', 200)]);
  assert.equal(chains.length, 1);
  assert.ok(chains[0].members.length === 2);
});

test('Codex 用 threadId 做链 key，同 thread 的两个 rollout 聚为一条', () => {
  const chains = buildChains([
    { key: 'codex:1', agent: 'codex', providerId: '01a07f29', parentId: null, firstTs: null, mtimeMs: 100 },
    { key: 'codex:2', agent: 'codex', providerId: '01a07f29', parentId: null, firstTs: null, mtimeMs: 200 },
  ]);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].chainKey, '01a07f29');
  assert.equal(chains[0].members.length, 2);
});

test('members 按 firstTs 升序', () => {
  const chains = buildChains([
    { key: 'k2', agent: 'claude', providerId: 'b', parentId: 'a', firstTs: '2026-09-08T05:00:00Z', mtimeMs: 500 },
    { key: 'k1', agent: 'claude', providerId: 'a', parentId: null, firstTs: '2026-09-08T03:00:00Z', mtimeMs: 100 },
  ]);
  assert.deepEqual(chains[0].members.map((m) => m.providerId), ['a', 'b']);
});
