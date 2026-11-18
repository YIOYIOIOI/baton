import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileRevocations } from '../src/revocations.js';
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

test('文件坏了按空表处理，不拒绝所有人', (t) => {
  const file = path.join(tmpDir(), 'revoked.json');
  fs.writeFileSync(file, '{ 半截');
  t.mock.method(console, 'error', () => {});
  const r = fileRevocations(file);
  assert.equal(r.isRevoked('x'), false);
  assert.equal(r.isLegacyRevoked('owner'), false);
});

test('别的进程改了表（npm run revoke-legacy），不重启就生效', () => {
  const file = path.join(tmpDir(), 'revoked.json');
  const daemon = fileRevocations(file);
  assert.equal(daemon.isLegacyRevoked('owner'), false);
  fileRevocations(file).revokeLegacy('owner'); // 另一个进程
  assert.equal(daemon.isLegacyRevoked('owner'), true);
});
