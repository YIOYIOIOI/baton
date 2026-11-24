import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, startHost } from './host.mjs';

test('an accepted guest message survives a suspended enrollment and runs once after repair', { timeout: 50000 }, async (t) => {
  const host = await startHost(t, { guestCanSend: true });
  const route = '/api/sessions/' + encodeURIComponent(host.key);
  const configFile = path.join(host.root, 'state', 'principals.json');
  const good = fs.readFileSync(configFile);
  const pair = await host.request('/api/pair', { bearer: null, body: { code: await host.codeFor('reader'), want: 'bearer' } });
  const { bearer } = await pair.json();
  assert.equal(pair.status, 200);
  const active = 'Keep the fixture busy until shutdown';
  fs.writeFileSync(path.join(host.cwd, 'hold-prompt.txt'), active);
  assert.equal((await host.request(route + '/send', { body: { message: active } })).status, 202);
  await eventually(() => fs.readFileSync(host.transcript, 'utf8').includes(active), 12000, 'fixture worker started');
  const body = { message: 'Run after identity verification recovers', requestId: crypto.randomUUID() };
  const queued = await host.request(route + '/send', { bearer, body });
  const receipt = await queued.json();
  assert.equal(queued.status, 202);
  assert.ok(receipt.queueId);

  fs.writeFileSync(configFile, '{');
  await host.restart();
  assert.equal((await host.request('/api/health', { bearer })).status, 401);
  const state = await (await host.request(route + '/state')).json();
  assert.deepEqual(state.queued.map((item) => item.id), [receipt.queueId]);
  assert.ok(!fs.readFileSync(host.transcript, 'utf8').includes(body.message));

  fs.writeFileSync(configFile, good);
  await host.restart();
  await eventually(async () => {
    const access = await host.request(route + '/state', { bearer });
    if (!access.ok) return false;
    const state = await access.json();
    return state.latestTurn?.status === 'ok' && !state.queued.length && fs.readFileSync(host.transcript, 'utf8').includes(body.message);
  }, 15000, 'original device and its queue recovered');
  assert.equal((await (await host.request(route + '/send', { bearer, body })).json()).queueId, receipt.queueId);
  const rows = fs.readFileSync(host.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.type === 'user' && row.message.content === body.message).length, 1);
});

test('queue promotion interrupts the active child and preserves the other accepted messages', { timeout: 40000 }, async (t) => {
  const host = await startHost(t);
  const route = '/api/sessions/' + encodeURIComponent(host.key);
  const prompts = () => fs.readFileSync(host.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((row) => row.type === 'user').map((row) => row.message.content);
  async function post(endpoint, body, expected = 202) {
    const response = await host.request(route + endpoint, { body });
    assert.equal(response.status, expected);
    return response.json();
  }
  const job = (message) => ({ message, requestId: crypto.randomUUID() });
  const active = job('Wait until interrupted');
  fs.writeFileSync(path.join(host.cwd, 'hold-prompt.txt'), active.message);
  await post('/send', active);
  await eventually(() => prompts().includes(active.message), 10000, 'active child reads its message');
  const first = job('Originally first');
  const next = job('Promote this one');
  const dropped = job('Withdraw this one');
  const firstAck = await post('/send', first);
  const nextAck = await post('/send', next);
  const dropAck = await post('/send', dropped);
  assert.ok(firstAck.queueId && nextAck.queueId && dropAck.queueId);
  await post('/queue/cancel', { id: dropAck.queueId }, 200);
  assert.equal((await post('/send', dropped)).queueId, dropAck.queueId);
  const promoted = await post('/queue/promote', { id: nextAck.queueId });
  assert.equal(promoted.queueId, nextAck.queueId);
  await eventually(async () => {
    const state = await (await host.request(route + '/state')).json();
    assert.ok(prompts().includes(first.message) && state.latestTurn?.status === 'ok' && state.queued.length === 0,
      'Observed prompts: ' + JSON.stringify(prompts()) + ', turn: ' + state.latestTurn?.status + ', queued: ' + state.queued.length);
    return true;
  }, 18000, 'promoted child and remaining queued child complete');
  assert.deepEqual(prompts(), [host.greeting, active.message, next.message, first.message]);
  assert.equal((await post('/send', next)).queueId, nextAck.queueId);
});
