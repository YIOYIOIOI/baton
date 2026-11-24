import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION } from '../src/version.js';
import { buildRoutes } from '../src/http/routes.js';
import { createAuth } from '../src/http/auth.js';
import { OWNER, OWNER_ID } from '../src/principals.js';

test('VERSION 读取 package.json 且与包声明一致', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('GET /api/health 返回 version 与调用者 principal 概要', async () => {
  const guest = { id: 'alice', name: 'Alice', roots: ['/tmp/ws'], allowSend: false };
  const auth = createAuth({ token: 'a'.repeat(64), principals: [OWNER, guest] });
  const health = buildRoutes({ auth }).find((r) => r.name === 'health');

  const ownerRes = await health.run({ config: { allowSend: true }, principal: OWNER });
  assert.equal(ownerRes.status, 200);
  assert.equal(ownerRes.body.version, VERSION);
  assert.equal(ownerRes.body.deviceId, null);
  assert.deepEqual(ownerRes.body.principal, { id: OWNER_ID, isOwner: true });

  const guestRes = await health.run({ config: { allowSend: false }, principal: guest, deviceId: 'paired-device' });
  assert.equal(guestRes.status, 200);
  assert.equal(guestRes.body.version, VERSION);
  assert.equal(guestRes.body.deviceId, 'paired-device');
  assert.deepEqual(guestRes.body.principal, { id: 'alice', isOwner: false });
});
