import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { memoryRevocations } from '../src/revocations.js';
import { OWNER, OWNER_ID } from '../src/principals.js';
import { parseDeviceAgent, fileDevices, memoryDevices } from '../src/devices.js';
import { buildRoutes } from '../src/http/routes.js';
import { tmpDir } from './helpers.js';

const TOKEN = 'd'.repeat(64);
const GUEST = { id: 'friend', name: 'Alice', roots: [tmpDir()], allowSend: false };

test('parseDeviceAgent 从常见 UA 提取简洁设备标签，不存原始隐私串', () => {
  assert.deepEqual(parseDeviceAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'), {
    label: 'iPhone · Safari',
    platform: 'iPhone',
  });
  assert.deepEqual(parseDeviceAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'), {
    label: 'macOS · Chrome',
    platform: 'macOS',
  });
  assert.deepEqual(parseDeviceAgent('Baton/0.2.0 CFNetwork/1568 Darwin/24.0'), {
    label: 'Baton App',
    platform: 'Mobile',
  });
  assert.deepEqual(parseDeviceAgent(''), {
    label: 'Paired Device',
    platform: 'Unknown',
  });
});

test('fileDevices 原子持久化并在 60 秒内节流 touch', () => {
  const file = path.join(tmpDir(), 'devices.json');
  const store = fileDevices(file);
  store.register({ deviceId: 'dev1', principalId: OWNER_ID, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Edg/131.0', now: 1000 });
  store.touch('dev1', 20_000); // 仅过 19 秒：节流不落盘
  const reloaded = fileDevices(file);
  assert.equal(reloaded.get('dev1').lastSeenAt, 1000);
  store.touch('dev1', 70_000); // 超过 60 秒：落盘更新
  assert.equal(fileDevices(file).get('dev1').lastSeenAt, 70_000);
});

test('设备清单异常时保留最近快照，拒绝覆盖，修复后可重试', (t) => {
  const file = path.join(tmpDir(), 'devices.json');
  const store = fileDevices(file);
  const entry = { deviceId: 'device-a', principalId: 'friend', now: 1 };
  store.register(entry);
  const valid = fs.readFileSync(file, 'utf8');
  t.mock.method(console, 'error', () => {});
  const badGeneration = JSON.parse(valid);
  badGeneration.devices['device-a'].generation = 7;
  for (const invalid of ['{', '{"devices":[]}', '{"devices":{"device-a":null}}', JSON.stringify(badGeneration)]) {
    fs.writeFileSync(file, invalid);
    assert.equal(store.list()[0]?.id, 'device-a');
    assert.equal(store.touch('device-a', 100_000), false);
    assert.throws(() => store.register({ ...entry, deviceId: 'device-b' }));
    assert.throws(() => store.remove('device-a'));
    assert.equal(fs.readFileSync(file, 'utf8'), invalid);
  }
  fs.writeFileSync(file, valid);
  assert.equal(store.touch('device-a', 100_000), true);
  store.register({ ...entry, deviceId: 'device-b' });
  assert.equal(fileDevices(file).list().length, 2);
});

test('owner 可按已知设备号吊销清单缺失的设备；访客不能借此吊销其他设备', async () => {
  await withDeviceServer(async ({ base, auth, devices }) => {
    const missing = auth.verifyPair(auth.newPairingCode('friend'));
    const guest = auth.verifyPair(auth.newPairingCode('friend'));
    devices.remove(missing.deviceId);
    const revoke = (bearer, deviceId) => fetch(`${base}/api/devices/revoke`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    assert.equal((await revoke(guest.bearer, missing.deviceId)).status, 404);
    assert.equal((await revoke(TOKEN, missing.deviceId)).status, 200);
    assert.equal(auth.authorize({ headers: { authorization: `Bearer ${missing.bearer}` } }).ok, false);
  });
});

async function withDeviceServer(fn, { config = {} } = {}) {
  let clock = 1_000_000;
  const revocations = memoryRevocations();
  const devices = memoryDevices();
  const auth = createAuth({ token: TOKEN, principals: [OWNER, GUEST], revocations, devices, now: () => clock });
  const repo = { listChains: () => [], getSession: () => null };
  const server = createServer({
    repo, auth,
    config: { host: '127.0.0.1', port: 0, allowSend: false, ...config },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, port, auth, devices, advance: (ms) => { clock += ms; } });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('HTTP 配对、设备列表（owner/guest 隔离）、远程吊销实时生效', async () => {
  await withDeviceServer(async ({ base, auth }) => {
    const code1 = auth.newPairingCode(OWNER_ID);
    const pair1 = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1' },
      body: JSON.stringify({ code: code1, want: 'bearer' }),
    });
    assert.equal(pair1.status, 200);
    // 明文 127.0.0.1 HTTP 请求不下发 Secure cookie
    assert.doesNotMatch(pair1.headers.get('set-cookie') ?? '', /;\s*Secure\b/i);
    const { bearer: ownerBearer } = await pair1.json();

    const code2 = auth.newPairingCode('friend');
    const pair2 = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/131.0' },
      body: JSON.stringify({ code: code2, want: 'bearer' }),
    });
    const { bearer: guestBearer } = await pair2.json();

    // owner 看到两台设备，自己的标为 current: true
    const ownerList = await (await fetch(`${base}/api/devices`, {
      headers: { authorization: `Bearer ${ownerBearer}` },
    })).json();
    assert.equal(ownerList.devices.length, 2);
    const cur = ownerList.devices.find((d) => d.current);
    const other = ownerList.devices.find((d) => !d.current);
    assert.equal(cur.platform, 'iPhone');
    assert.equal(other.principalId, 'friend');

    // guest 只能看到自己的，且不能吊销 owner 的设备
    const guestList = await (await fetch(`${base}/api/devices`, {
      headers: { authorization: `Bearer ${guestBearer}` },
    })).json();
    assert.deepEqual(guestList.devices.map((d) => d.id), [other.id]);

    const deny = await fetch(`${base}/api/devices/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${guestBearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: cur.id }),
    });
    assert.equal(deny.status, 404);

    // owner 吊销 guest 设备后，guest bearer 立即 401
    const rev = await fetch(`${base}/api/devices/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerBearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: other.id }),
    });
    assert.equal(rev.status, 200);
    assert.equal((await rev.json()).revoked, true);

    const blocked = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${guestBearer}` },
    });
    assert.equal(blocked.status, 401);
  });
});

test('POST /api/pair/qr 仅限 owner，生成合法配对码与 SVG 二维码', async () => {
  const auth = createAuth({ token: TOKEN, principals: [OWNER, GUEST] });
  const mintQr = buildRoutes({ auth }).find((r) => r.name === 'mintPairQr');

  const denied = await mintQr.run({
    principal: GUEST, body: {}, config: { host: '127.0.0.1', port: 3002 }, req: { headers: {} },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'owner_only');

  const ok = await mintQr.run({
    principal: OWNER,
    body: {},
    config: { host: '127.0.0.1', port: 3002, publicUrl: 'https://baton.example.com' },
    req: { headers: {} },
    interfaces: { eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.25' }] },
  });
  assert.equal(ok.status, 200);
  assert.match(ok.body.code, /^[A-Z2-9]{12}$/);
  assert.equal(ok.body.url, `https://baton.example.com/pair?c=${ok.body.code}`);
  assert.match(ok.body.svg, /^<svg\b/);
  assert.equal(ok.body.network.lan, '192.168.1.25');
});
