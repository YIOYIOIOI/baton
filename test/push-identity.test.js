import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { BATON_DIR } from '../src/config.js';
import { createAuth } from '../src/http/auth.js';
import { createServer } from '../src/http/server.js';
import { loadPrincipals, OWNER } from '../src/principals.js';
import { fileRevocations } from '../src/revocations.js';
import { ensureKeys, listSubscriptions, notify, setLatest, subscribe } from '../src/push.js';
import { pushSubscribeHandler } from '../src/http/handlers/push.js';
import { tmpDir } from './helpers.js';

async function duringSubscription(principalId, deviceId, endpoint, change) {
  const child = fork(new URL('./fixtures/staged-push.mjs', import.meta.url), [principalId, deviceId, endpoint], {
    execArgv: [], windowsHide: true,
    env: { ...process.env, BATON_DIR, CODEX_HOME: path.join(BATON_DIR, 'synthetic-codex'), CLAUDE_CONFIG_DIR: path.join(BATON_DIR, 'synthetic-claude') },
  });
  const exit = once(child, 'exit');
  try {
    const staged = once(child, 'message');
    child.send('start');
    assert.deepEqual(await staged, ['staged', undefined]);
    change();
    assert.equal((await exit)[0], 0);
  } finally { if (child.exitCode === null) child.kill(); }
}

test('订阅上限按身份计算，满额时续订仍然成功', () => {
  const principal = { id: 'quota' };
  const device = 'quota-device-001';
  const register = (i) => pushSubscribeHandler({ endpoint: 'https://push.example/quota-' + i }, principal, device);
  for (let i = 0; i < 32; i++) assert.equal(register(i).status, 200);
  assert.equal(register(32).status, 429);
  assert.equal(register(1).status, 200);
  assert.equal(pushSubscribeHandler({ endpoint: 'https://push.example/another' }, { id: 'other-quota' }, 'other-device-001').status, 200);
});

test('在最后一个配额或设备被吊销时，与另一个进程已经开始的订阅提交串行化', async () => {
  const auth = createAuth({ token: 'x'.repeat(64), revocations: fileRevocations(path.join(BATON_DIR, 'revoked.json')) });
  const paired = auth.verifyPair(auth.newPairingCode());
  const endpoint = 'https://push.example/interleaved-revoke';
  await duringSubscription('owner', paired.deviceId, endpoint, () => auth.revokeDevice(paired.deviceId));
  assert.equal(listSubscriptions().some((s) => s.endpoint === endpoint), false);
  const principalId = 'interleaved-quota';
  const deviceId = 'quota-process-01';
  const ep = (i) => 'https://push.example/interleaved-' + i;
  for (let i = 0; i < 31; i++) subscribe({ endpoint: ep(i) }, principalId, deviceId);
  await duringSubscription(principalId, deviceId, ep(31), () => {
    assert.throws(() => subscribe({ endpoint: ep(32) }, principalId, deviceId), { code: 'push_subscription_limit' });
  });
  assert.equal(listSubscriptions().filter((s) => s.principalId === principalId).length, 32);
});

test('整批推送到达总时限时释放等待，较迟返回的 DNS 不再发请求', async () => {
  const principalId = 'deadline';
  const endpoint = 'https://push.example/deadline';
  subscribe({ endpoint }, principalId, 'deadline-test-01');
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let sent = 0;
  const guard = setTimeout(() => release([{ address: '93.184.216.34', family: 4 }]), 700);
  try {
    const result = await notify({ principalId, timeoutMs: 30, lookup: () => pending, fetchImpl: async () => { sent++; return { status: 201, ok: true }; } });
    assert.equal(result.sent, 0);
    release([{ address: '93.184.216.34', family: 4 }]);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent, 0);
  } finally { clearTimeout(guard); }
});

test('订阅归属来自已配对设备，吊销会清理订阅；旧推送摘要再次查询当前会话作用域和代际', async () => {
  const dir = tmpDir();
  const guest = { id: 'push-guest', generation: 'enrollment-a', roots: [dir], allowSend: false };
  const auth = createAuth({ token: 't'.repeat(64), principals: [OWNER, guest], revocations: fileRevocations(path.join(BATON_DIR, 'revoked.json')) });
  const first = auth.verifyPair(auth.newPairingCode(guest.id));
  const second = auth.verifyPair(auth.newPairingCode(guest.id));
  const key = 'claude:visible';
  let member = { key, cwd: dir };
  const server = createServer({ auth, repo: { getSession: (id) => id === key ? member : null, listChains: () => [] }, config: { allowSend: false } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = (name, bearer, body) => fetch(base + '/api/' + name, { method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ep = (id) => 'https://push.example/device-' + id;
  const hit = [];
  const send = () => notify({ principalId: guest.id, generation: guest.generation, fetchImpl: async (url) => { hit.push(url); return { status: 201, ok: true }; } });
  try {
    assert.equal((await api('push/subscribe', 't'.repeat(64), { endpoint: ep('master') })).status, 403);
    for (const [i, device] of [first, second].entries()) {
      assert.equal((await api('push/subscribe', device.bearer, { endpoint: ep(i), deviceId: 'forged', principalId: 'owner' })).status, 200);
      assert.equal(listSubscriptions().find((s) => s.endpoint === ep(i)).deviceId, device.deviceId);
    }
    await api('push/unsubscribe', second.bearer, { endpoint: ep(0) });
    assert.equal((await send()).sent, 2);
    hit.length = 0;
    const lookupEntered = Promise.withResolvers();
    const lookupReady = Promise.withResolvers();
    const pending = notify({ principalId: guest.id, generation: guest.generation, lookup: async () => { lookupEntered.resolve(); return lookupReady.promise; },
      fetchImpl: async (url) => { hit.push(url); return { status: 201, ok: true }; } });
    await lookupEntered.promise;
    assert.equal((await api('devices/revoke', second.bearer, { deviceId: first.deviceId })).status, 200);
    assert.equal(listSubscriptions().some((s) => s.deviceId === first.deviceId), false);
    lookupReady.resolve([{ address: '93.184.216.34', family: 4 }]);
    assert.equal((await pending).sent, 1, '解析期间吊销的设备也不投递');
    assert.deepEqual(hit, [ep(1)]);
    const latest = async () => (await api('push/latest', second.bearer)).json();
    const empty = { title: null, status: null, key: null };
    setLatest(guest.id, { key, title: 'allowed', generation: guest.generation });
    assert.equal((await latest()).title, 'allowed');
    member = { key, cwd: tmpDir() };
    assert.deepEqual(await latest(), empty);
    member = { key, cwd: dir };
    setLatest(guest.id, { key, title: 'previous guest', generation: 'enrollment-old' });
    assert.deepEqual(await latest(), empty);
  } finally { await new Promise((r) => server.close(r)); }
});

test('已有无设备号的订阅在同一浏览器重新登记后恢复；响应只读状态，立即释放持续发送的响应体', async () => {
  const state = ensureKeys();
  const principalId = 'migration';
  const endpoint = 'https://push.example/migrate';
  fs.writeFileSync(path.join(BATON_DIR, 'push.json'), JSON.stringify({ ...state, subscriptions: [...state.subscriptions, { endpoint, principalId }] }));
  let destroyed = false;
  const opts = { principalId, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: (_options, cb) => ({ on() {}, setTimeout() {}, end() { cb({ statusCode: 201, resume() {}, destroy() { destroyed = true; } }); } }) };
  assert.equal((await notify(opts)).sent, 0);
  subscribe({ endpoint }, principalId, 'migration-test01');
  assert.equal((await notify(opts)).sent, 1);
  assert.equal(destroyed, true);
});

test('轮次结束前身份被重新分配时，老进程也停止投递；推送服务不回响应头时请求被中止', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'principals.json');
  const principalId = 'rotating';
  fs.writeFileSync(file, JSON.stringify({ guests: [{ id: principalId }] }));
  const read = () => loadPrincipals({ dir, workspacesRoot: dir, manageGenerations: true }).principals[1];
  const principal = read();
  const endpoint = 'https://push.example/rotate';
  subscribe({ endpoint }, principalId, 'rotating-device1', principal.generation);
  const opts = { principal, principalId, generation: principal.generation, lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
  let signal;
  const stalled = notify({ ...opts, timeoutMs: 40, requestImpl: (request) => {
    signal = request.signal;
    return { on() {}, end() {} };
  } });
  assert.deepEqual(await stalled, { sent: 0, dropped: 0 });
  assert.equal(signal.aborted, true);
  fs.writeFileSync(file, JSON.stringify({ guests: [{ id: principalId, credentialVersion: 2 }] }));
  assert.notEqual(read().generation, principal.generation);
  let sent = false;
  await notify({ ...opts, fetchImpl: async () => { sent = true; return { ok: true, status: 201 }; } });
  assert.equal(sent, false);
});
