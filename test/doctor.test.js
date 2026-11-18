import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDoctor } from '../src/doctor.js';
import { VERSION } from '../src/version.js';
import { tmpDir } from './helpers.js';

test('runDoctor 输出结构化检查项、网络地址与版本，缺少可选 CLI 时不判失败', async () => {
  const batonDir = tmpDir();
  const home = tmpDir();
  fs.writeFileSync(path.join(batonDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 3002, allowSend: true }));
  fs.writeFileSync(path.join(batonDir, 'token'), 'a'.repeat(64));

  const report = await runDoctor({
    batonDir,
    home,
    env: {},
    config: { host: '127.0.0.1', port: 3002, allowSend: true, publicUrl: null },
    interfaces: { eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.40' }] },
    checkCmd: async (cmd) => (cmd === 'claude' ? { ok: true, version: '2.1.0' } : { ok: false, version: null }),
  });

  assert.equal(report.version, VERSION);
  assert.equal(report.ok, true);
  assert.equal(report.network.lan, '192.168.1.40');
  const nodeCheck = report.checks.find((c) => c.id === 'node');
  assert.equal(nodeCheck.status, 'ok');
  const claudeCheck = report.checks.find((c) => c.id === 'cli:claude');
  assert.equal(claudeCheck.status, 'ok');
  const codexCheck = report.checks.find((c) => c.id === 'cli:codex');
  assert.equal(codexCheck.status, 'warn');
});
