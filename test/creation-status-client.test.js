import test from 'node:test';
import assert from 'node:assert/strict';
import { watchCreation } from '../app/src/api/creationStatus.ts';

const turnId = 'local-creation';
const receipt = { turnId, statusUrl: '/api/session-creations/' + turnId };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('新建页仅轮询原回执，临时离线和未确认均不重投，确认后停止查询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const urls = [], keys = [], failures = [];
  const responses = [new Error('offline'), { turnId, status: 'unconfirmed' }, { turnId, status: 'identified', key: 'session' }];
  const stop = watchCreation(receipt, async (url) => {
    urls.push(url);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }, (key) => keys.push(key), (message) => failures.push(message));
  await flush();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(2000); await flush(); }
  assert.deepEqual(urls, Array(3).fill(receipt.statusUrl));
  assert.deepEqual(keys, ['session']);
  assert.deepEqual(failures, []);
  stop();
});

test('离开新建页或切换身份后，中止正在查询的请求并丢弃迟到的身份', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = Promise.withResolvers();
  let reads = 0, signal;
  const outcomes = [];
  const stop = watchCreation(receipt, (_url, pending) => { reads++; signal = pending; return result.promise; },
    (key) => outcomes.push(key), (message) => outcomes.push(message));
  t.mock.timers.tick(60_000);
  assert.equal(reads, 1);
  stop();
  assert.equal(signal.aborted, true);
  result.resolve({ turnId, status: 'identified', key: 'previous-session' });
  await flush();
  t.mock.timers.tick(60_000);
  assert.deepEqual(outcomes, []);
  assert.equal(reads, 1);
});

test('授权失效、确定失败或地址与回执不符时停止该次轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const scenario of ['failed', 'denied', 'different']) {
    const outcomes = [];
    let reads = 0;
    const stop = watchCreation(scenario === 'different' ? { ...receipt, statusUrl: '/api/session-creations/other' } : receipt, async () => {
      reads++;
      if (scenario === 'denied') throw Object.assign(new Error(), { status: 404 });
      return { turnId, status: 'failed', error: '未派发' };
    }, (key) => outcomes.push(key), (message) => outcomes.push(message));
    await flush();
    t.mock.timers.tick(60_000);
    assert.deepEqual(outcomes, [scenario === 'failed' ? '未派发' : '']);
    assert.equal(reads, scenario === 'different' ? 0 : 1);
    stop();
  }
});
