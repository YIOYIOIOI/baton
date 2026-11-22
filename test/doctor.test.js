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

test('Windows doctor reports the host-selected PowerShell 7 used for file downloads', { skip: process.platform !== 'win32' }, async () => {
  const home = tmpDir();
  const tool = path.join(home, 'tools', 'pwsh.exe');
  fs.mkdirSync(path.dirname(tool));
  fs.writeFileSync(tool, 'fixture');
  async function diagnose(value, programDirs = {}) {
    const env = value === undefined ? programDirs : { ...programDirs, BATON_PWSH7: value };
    const report = await runDoctor({ home, batonDir: home, env,
      config: { host: '127.0.0.1', port: 0 }, interfaces: {}, checkCmd: async () => ({ ok: false, version: null }) });
    return report.checks.find((c) => c.id === 'file-verifier');
  }
  const present = await diagnose(tool);
  assert.equal(present.status, 'ok');
  assert.ok(present.detail.includes(tool));
  const missingPath = path.join(home, 'missing', 'pwsh.exe');
  const missing = await diagnose(missingPath);
  assert.equal(missing.status, 'warn');
  assert.ok(missing.detail.includes(missingPath));
  assert.match(missing.detail, /missing/i);
  assert.match(missing.detail, /GET \/api\/sessions\/:key\/file/);
  assert.match(missing.detail, /GET \/api\/sessions\/:key\/upload/);
  for (const invalid of ['pwsh.exe', 'C:pwsh.exe', path.join(home, 'powershell.exe'), path.dirname(tool) + '\\..\\tools\\pwsh.exe']) {
    const rejected = await diagnose(invalid);
    assert.equal(rejected.status, 'warn');
    assert.match(rejected.detail, /invalid BATON_PWSH7/i);
  }
  assert.ok((await diagnose(undefined)).detail.includes('C:\\Program Files\\PowerShell\\7\\pwsh.exe'));
  const root64 = path.join(home, 'Program Files');
  const root32 = path.join(home, 'Program Files (x86)');
  const standard = (root) => path.join(root, 'PowerShell', '7', 'pwsh.exe');
  assert.ok((await diagnose(undefined, { ProgramW6432: root64, ProgramFiles: root32 })).detail.includes(standard(root64)));
  assert.ok((await diagnose(undefined, { ProgramFiles: root32 })).detail.includes(standard(root32)));
});
