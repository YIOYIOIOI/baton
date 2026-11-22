import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAgyBinary, execAgy } from '../src/agent/agy.js';
import { runAntigravityTurn, runAntigravityAcpTurn } from '../src/agent/antigravityRun.js';
import { probeAntigravityViaAcp } from '../src/agent/catalog.js';
import { runBuffered, runProcess } from '../src/agent/spawn.js';
import { runDoctor } from '../src/doctor.js';
import { cliLaunch } from '../src/agent/codexRuntime.js';
import { tmpDir } from './helpers.js';

const windows = { skip: process.platform !== 'win32' };
const fixture = fileURLToPath(new URL('./fixtures/agy-launch.mjs', import.meta.url));
const session = (cwd) => ({ cwd, providerId: '00000000-0000-4000-8000-000000000001', agent: 'antigravity' });

test('Windows AGY discovery uses physical host installations, ignoring relative paths and workspace aliases', windows, (t) => {
  const cwd = tmpDir();
  const host = tmpDir();
  const local = tmpDir();
  const projectBin = path.join(cwd, 'bin');
  const link = path.join(host, 'mapped-project');
  const install = path.join(host, 'CLI tools');
  fs.mkdirSync(projectBin);
  fs.mkdirSync(install);
  fs.symlinkSync(projectBin, link, 'junction');
  fs.writeFileSync(path.join(projectBin, 'agy.exe'), '');
  const trusted = path.join(install, 'agy.cmd');
  fs.writeFileSync(trusted, '');
  const previousCwd = process.cwd();
  process.chdir(host);
  t.after(() => process.chdir(previousCwd));
  const relative = path.relative(host, trusted);
  assert.ok(!path.isAbsolute(relative) && fs.existsSync(relative));
  assert.equal(findAgyBinary({ cwd, env: { AGY_BIN: relative } }), null);
  for (const choice of [relative, path.join(link, 'agy.exe'), path.join(projectBin, 'agy.exe'), path.toNamespacedPath(path.join(projectBin, 'agy.exe'))]) {
    assert.equal(findAgyBinary({ cwd, env: { AGY_BIN: choice, PATH: install } }), trusted);
  }
  assert.equal(findAgyBinary({ cwd, env: { Path: [path.dirname(relative), '.', projectBin, link].join(';') } }), null);
  const common = path.join(local, 'agy', 'bin', 'agy.exe');
  fs.mkdirSync(path.dirname(common), { recursive: true });
  fs.writeFileSync(common, '');
  assert.equal(findAgyBinary({ cwd, env: { LOCALAPPDATA: local, Path: install } }), common);
  const alias = path.join(host, 'mapped-install');
  fs.symlinkSync(install, alias, 'junction');
  assert.equal(findAgyBinary({ cwd, env: { AGY_BIN: path.join(alias, 'agy.cmd') } }), trusted);
  assert.equal(findAgyBinary({ cwd, env: { AGY_BIN: path.toNamespacedPath(trusted) } }), trusted);
});

test('direct ACP and catalog entry points validate explicitly supplied AGY files before spawning', windows, async () => {
  const cwd = tmpDir();
  const agyBin = path.join(cwd, 'agy.exe');
  fs.writeFileSync(agyBin, '');
  const spawnFn = () => { throw new Error('unexpected workspace launch'); };
  const env = { PATH: '', CLAUDE_CONFIG_DIR: tmpDir() };
  await assert.rejects(cliLaunch(agyBin, env, true, cwd), /agy/i);
  const r = await runAntigravityAcpTurn({ cwd, member: session(cwd), agyBin, env, message: 'hello', spawnFn });
  assert.equal(r.summary.status, 'failed');
  assert.equal(await probeAntigravityViaAcp({ agyBin, cwd, env, spawnFn }), null);
});

test('an explicitly selected native executable works without shell quoting and retains its session directory', async () => {
  const cwd = tmpDir();
  const env = { PATH: path.dirname(process.execPath), CLAUDE_CONFIG_DIR: tmpDir(), SystemRoot: process.env.SystemRoot };
  const r = await execAgy(['-p', 'process.cwd()'], { agyBin: process.execPath, cwd, env, timeoutMs: 5000 });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), fs.realpathSync.native(cwd));
});

test('AGY shim launches use the host PATH for ACP, CLI fallback, catalog and short commands', windows, async () => {
  const cwd = tmpDir();
  const install = path.join(tmpDir(), 'CLI tools');
  fs.mkdirSync(install);
  const bin = path.join(install, 'agy.cmd');
  fs.copyFileSync(fixture, path.join(install, 'runner.mjs'));
  fs.writeFileSync(bin, '@echo off\r\nnode "%~dp0runner.mjs" %*\r\n');
  const log = path.join(tmpDir(), 'launch.jsonl');
  const nodeDir = path.dirname(process.execPath);
  const env = { Path: ['.', cwd, 'relative-tools', install, nodeDir].join(';'), AGY_BIN: bin,
    SystemRoot: process.env.SystemRoot, CLAUDE_CONFIG_DIR: tmpDir(), BATON_FIXTURE_LOG: log };
  const member = session(cwd);
  const acp = await runAntigravityAcpTurn({ member, env, agyBin: bin, message: 'hello', timeoutMs: 5000 });
  assert.equal(acp.summary.status, 'ok', acp.stderr);
  const cli = await runAntigravityTurn({ member: { ...member, relPath: 'antigravity-cli/test' }, env, message: 'hello' });
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal((await probeAntigravityViaAcp({ cwd, agyBin: bin, env, timeoutMs: 5000 })).defaultModel.name, 'Fixture');
  assert.equal((await execAgy(['models'], { cwd, agyBin: bin, env, timeoutMs: 5000 })).code, 0);
  assert.equal((await runProcess({ command: 'agy', cwd, env, args: ['--version'] })).code, 0);
  const report = await runDoctor({ batonDir: tmpDir(), home: tmpDir(), interfaces: {},
    env: { ...env, Path: ['.', 'relative-tools', install, nodeDir].join(';') },
    checkCmd: async (cmd, runtime) => {
      if (cmd !== bin) return { ok: false, version: null };
      assert.ok(runtime, 'Doctor must preserve the verified launch options');
      const r = await runBuffered(cmd, ['--version'], { runtime, timeoutMs: 5000 });
      return { ok: r.code === 0, version: 'fixture' };
    } });
  assert.equal(report.checks.find((c) => c.id === 'cli:agy').status, 'ok');
  const records = fs.readFileSync(log, 'utf8').trim().split('\n').map((row) => JSON.parse(row));
  assert.equal(records.length, 6);
  for (const r of records) {
    assert.equal(r.guard, '1');
    assert.deepEqual(r.path.split(';'), [fs.realpathSync.native(install), fs.realpathSync.native(nodeDir)]);
  }
});
