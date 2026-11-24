import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileRevocations } from '../src/revocations.js';
import { memoryDevices } from '../src/devices.js';
import { createAuth } from '../src/http/auth.js';
import { tmpDir } from './helpers.js';

/**
 * ~/.baton/revoked.json：解除配对作废的设备凭据要扛得住守护进程重启，
 * 命令行改了表守护进程要不重启就读到，文件坏了不能把 owner 锁在门外。
 */

const TOKEN = 'e'.repeat(64);
const req = (headers = {}) => ({ headers, url: '/api/sessions' });

test('作废记录落盘，重启（新实例）后仍然作废', () => {
  const file = path.join(tmpDir(), 'revoked.json');
  const a1 = createAuth({ token: TOKEN, revocations: fileRevocations(file) });
  const bearer = a1.verifyPair(a1.newPairingCode()).bearer;
  assert.equal(a1.revoke(req({ authorization: `Bearer ${bearer}` })), 'device');

  const a2 = createAuth({ token: TOKEN, revocations: fileRevocations(file) });
  assert.equal(a2.authorize(req({ authorization: `Bearer ${bearer}` })).ok, false);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(saved.devices).length, 1);
  assert.ok(!JSON.stringify(saved).includes(bearer), '表里只记设备号，不存凭据本身');
});

test('文件不存在 = 什么都没作废', () => {
  const r = fileRevocations(path.join(tmpDir(), 'nope', 'revoked.json'));
  assert.equal(r.isRevoked('x'), false);
  assert.equal(r.isLegacyRevoked('owner'), false);
});

test('新进程遇到损坏的吊销表时拒绝设备及旧凭据，主 token 仍可用于恢复', (t) => {
  const file = path.join(tmpDir(), 'revoked.json');
  t.mock.method(console, 'error', () => {});
  const issuer = createAuth({ token: TOKEN });
  const { bearer, deviceId } = issuer.verifyPair(issuer.newPairingCode());
  const legacy = createHmac('sha256', TOKEN).update('baton-session-v1').digest('base64url');
  const invalidSnapshots = [
    '{ truncated', 'null', '{}', '{"devices":[],"legacy":[]}',
    '{"devices":{"dev-a":null},"legacy":[]}', '{"devices":{},"legacy":[null]}',
  ];
  for (const broken of invalidSnapshots) {
    fs.writeFileSync(file, broken);
    const store = fileRevocations(file);
    const auth = createAuth({ token: TOKEN, revocations: store });
    assert.equal(auth.authorize(req({ cookie: `baton_session=${bearer}` })).ok, false);
    assert.equal(auth.authorize(req({ authorization: `Bearer ${legacy}` })).ok, false);
    assert.equal(auth.isSessionValid({ deviceId, principalId: 'owner' }), false);
    assert.equal(auth.authorize(req({ authorization: `Bearer ${TOKEN}` })).ok, true);
    assert.throws(() => store.revokeLegacy('owner'));
    assert.throws(() => auth.revoke(req({ authorization: `Bearer ${bearer}` })), '解除配对必须能确认吊销已持久化');
    assert.equal(fs.readFileSync(file, 'utf8'), broken, '不可覆盖待修复的原始账本');
    fs.writeFileSync(file, JSON.stringify({ devices: {}, legacy: ['owner'] }));
    assert.equal(auth.authorize(req({ authorization: `Bearer ${bearer}` })).ok, true);
    assert.equal(auth.authorize(req({ authorization: `Bearer ${legacy}` })).ok, false);
  }
});

test('写盘失败不留下已成功的内存状态，同一个实例可重试两种吊销', (t) => {
  const file = path.join(tmpDir(), 'revoked.json');
  const store = fileRevocations(file);
  const rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.throws(() => store.revoke('dev-a', 'owner'), /synthetic write failure/);
  assert.throws(() => store.revokeLegacy('friend'), /synthetic write failure/);
  assert.equal(store.isRevoked('dev-a'), false);
  assert.equal(store.isLegacyRevoked('friend'), false);
  failure.mock.restore();
  store.revoke('dev-a', 'owner');
  assert.equal(store.revokeLegacy('friend'), true);
  const persisted = fileRevocations(file);
  assert.equal(persisted.isRevoked('dev-a'), true);
  assert.equal(persisted.isLegacyRevoked('friend'), true);
  assert.equal(store.revokeLegacy('friend'), false);
  assert.ok(fs.readdirSync(path.dirname(file)).every((name) => !name.endsWith('.tmp')));
});

test('吊销已写入时，设备列表清理失败也会通知活跃连接并报告成功', (t) => {
  const file = path.join(tmpDir(), 'revoked.json');
  const devices = memoryDevices();
  const auth = createAuth({ token: TOKEN, devices, revocations: fileRevocations(file) });
  const first = auth.verifyPair(auth.newPairingCode());
  const second = auth.verifyPair(auth.newPairingCode());
  t.mock.method(devices, 'remove', () => { throw new Error('synthetic registry failure'); });
  t.mock.method(console, 'error', () => {});
  const closed = [];
  auth.onRevoke(({ deviceId }) => closed.push(deviceId));
  assert.equal(auth.revokeDevice(first.deviceId, 'owner'), true);
  assert.equal(auth.revoke(req({ authorization: `Bearer ${second.bearer}` })), 'device');
  assert.deepEqual(closed, [first.deviceId, second.deviceId]);
  assert.deepEqual(auth.listDevices(), []);
  assert.equal(fileRevocations(file).isRevoked(first.deviceId), true);
});

test('旧格式账本同一时间戳的改动和已知账本丢失都不会放行', (t) => {
  const file = path.join(tmpDir(), 'revoked.json');
  const timestamp = new Date('2025-01-17T12:00:00Z');
  const store = fileRevocations(file);
  t.mock.method(console, 'error', () => {});
  for (const id of ['guest-a', 'guest-b']) {
    fs.writeFileSync(file, JSON.stringify({ devices: {}, legacy: [id] }));
    fs.utimesSync(file, timestamp, timestamp);
    assert.equal(store.isLegacyRevoked(id), true);
  }
  fs.unlinkSync(file);
  assert.equal(store.isRevoked('unknown-device'), true);
  assert.throws(() => store.revoke('another-device', 'owner'));
  const restarted = fileRevocations(file);
  assert.equal(restarted.isLegacyRevoked('guest-a'), true);
  assert.equal(restarted.isRevoked('unknown-device'), true);
  assert.throws(() => restarted.revokeLegacy('owner'));
});

test('首次吊销被确认后，另一个进程第一次鉴权也能识别丢失的账本', (t) => {
  const file = path.join(tmpDir(), 'revoked.json');
  t.mock.method(console, 'error', () => {});
  const issuer = createAuth({ token: TOKEN, revocations: fileRevocations(file) });
  const credential = issuer.verifyPair(issuer.newPairingCode());
  assert.ok(issuer.revokeDevice(credential.deviceId, 'owner'));
  fs.unlinkSync(file);
  const restarted = createAuth({ token: TOKEN, revocations: fileRevocations(file) });
  assert.equal(restarted.authorize(req({ authorization: 'Bearer ' + credential.bearer })).ok, false);
  assert.equal(restarted.authorize(req({ authorization: 'Bearer ' + TOKEN })).ok, true);
});

function writer(t, file, kind) {
  const dir = path.dirname(file);
  const child = fork(new URL('./fixtures/revocation-writer.mjs', import.meta.url), [file, kind], {
    execArgv: ['--import', new URL('./setup.js', import.meta.url).href],
    env: {
      SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: dir,
      TMP: dir, TEMP: dir, TMPDIR: dir, BATON_DIR: dir, CODEX_HOME: dir,
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill(); });
  return { child, ready: once(child, 'message'), done: once(child, 'exit') };
}

test('守护进程和独立 CLI 的设备与旧凭据吊销都能跨并发替换保留', { timeout: 10_000 }, async (t) => {
  const file = path.join(tmpDir(), 'revoked.json');
  const device = writer(t, file, 'device');
  const legacy = writer(t, file, 'legacy');
  await Promise.all([device.ready, legacy.ready]);
  const staged = once(device.child, 'message');
  device.child.send('start');
  await staged;
  legacy.child.send('start');
  for (const [code] of await Promise.all([device.done, legacy.done])) assert.equal(code, 0);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Object.hasOwn(saved.devices, 'dev-a'));
  assert.deepEqual(saved.legacy, ['friend']);
});

test('写入进程中途退出，旧账本完整且下一进程可继续吊销', { timeout: 10_000 }, async (t) => {
  const file = path.join(tmpDir(), 'revoked.json');
  fileRevocations(file).revokeLegacy('friend');
  const device = writer(t, file, 'device');
  await device.ready;
  const staged = once(device.child, 'message');
  device.child.send('start');
  await staged;
  device.child.kill();
  await device.done;
  const store = fileRevocations(file);
  assert.equal(store.isRevoked('dev-a'), false);
  assert.equal(store.isLegacyRevoked('friend'), true);
  store.revoke('dev-a', 'owner');
  assert.equal(store.isRevoked('dev-a'), true);
});

test('别的进程改了表（npm run revoke-legacy），不重启就生效', () => {
  const file = path.join(tmpDir(), 'revoked.json');
  const daemon = fileRevocations(file);
  assert.equal(daemon.isLegacyRevoked('owner'), false);
  fileRevocations(file).revokeLegacy('owner'); // 另一个进程
  assert.equal(daemon.isLegacyRevoked('owner'), true);
});
