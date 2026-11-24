import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cliLaunch } from '../src/agent/codexRuntime.js';
import { runProcess } from '../src/agent/spawn.js';
import { runAntigravityTurn } from '../src/agent/antigravityRun.js';
import { createSession } from '../src/http/handlers/create.js';
import { defaultRunner } from '../src/http/handlers/turns.js';
import { getMode, setMode } from '../src/permission.js';
import { tmpDir } from './helpers.js';

const sessionId = '00000000-0000-4000-8000-000000000001';

test('Windows resolves Claude only from absolute host PATH entries outside the session directory', {
  skip: process.platform !== 'win32',
}, async () => {
  const work = tmpDir();
  const projectBin = path.join(work, 'bin');
  const install = path.join(tmpDir(), 'CLI tools');
  fs.mkdirSync(projectBin);
  fs.mkdirSync(install);
  // Discovery needs only inert files in the workspace.
  fs.writeFileSync(path.join(work, 'claude.exe'), '');
  fs.writeFileSync(path.join(projectBin, 'claude.exe'), '');
  const excluded = ['', '.', 'bin', '\\bin', 'C:bin', work, projectBin];
  await assert.rejects(cliLaunch('claude', { Path: excluded.join(';') }, true, work), /Claude/i);

  const shim = path.join(install, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\necho simulated-cli\r\n');
  const env = { Path: [...excluded, '"' + install + '"'].join(';') };
  const batch = await cliLaunch('claude', env, true, work);
  assert.equal(batch.command, '"' + shim + '"');
  assert.ok(batch.shell);
  assert.equal(batch.env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.equal(batch.env.PATH, install);
  const result = await runProcess({ command: 'claude', args: ['--version'], cwd: work, env });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.lines, ['simulated-cli']);

  const native = path.join(install, 'claude.exe');
  fs.writeFileSync(native, '');
  const direct = await cliLaunch('claude', env, true, work);
  assert.equal(direct.command, native);
  assert.equal(direct.shell, false);
});

test('Codex refuses to hand configured turns to the desktop text queue', async () => {
  const previous = getMode('codex');
  let queued = 0;
  const opts = {
    member: { key: 'codex:policy', agent: 'codex', providerId: sessionId, cwd: tmpDir() },
    message: '查看进度',
    run: async () => ({ code: 1, lines: [], stderr: 'thread already has an active writer' }),
    toApp: async () => { queued += 1; return { id: 'queued' }; },
  };
  try {
    for (const mode of ['read', 'edits', 'bypass']) {
      setMode('codex', mode);
      const { summary } = await defaultRunner(opts);
      assert.equal(summary.status, 'failed');
      assert.match(summary.error, /权限/);
    }
    setMode('codex', 'default');
    assert.equal((await defaultRunner({ ...opts, model: 'selected-model' })).summary.status, 'failed');
    assert.equal((await defaultRunner({ ...opts, effort: 'high' })).summary.status, 'failed');
    const changed = await defaultRunner({
      ...opts,
      run: async () => { setMode('codex', 'read'); return opts.run(); },
    });
    assert.equal(changed.summary.status, 'failed');
    assert.equal(queued, 0);
    setMode('codex', 'default');
    assert.equal((await defaultRunner(opts)).summary.status, 'handoff');
    assert.equal(queued, 1);
  } finally {
    setMode('codex', previous);
  }
});

test('Antigravity requires a compatible executor for explicit turn settings', async () => {
  let discovered = 0;
  let submitted = 0;
  const opts = {
    member: { agent: 'antigravity', providerId: sessionId, cwd: tmpDir() },
    message: '查看进度',
    geminiConfigDir: tmpDir(),
    geminiRoot: tmpDir(),
    agyBin: null,
    env: { PATH: '', LOCALAPPDATA: '' },
    bridgeFinder: async () => { discovered += 1; return {}; },
    bridgeCaller: async () => { submitted += 1; return {}; },
    maxTurnMs: 0,
  };
  for (const settings of [{ permissionMode: 'plan' }, { model: 'pro' }, { effort: 'high' }]) {
    const { summary } = await runAntigravityTurn({ ...opts, ...settings });
    assert.equal(summary.status, 'failed');
    assert.match(summary.error, /agy CLI/);
  }
  assert.equal(discovered, 0);
  assert.equal(submitted, 0);

  let applied;
  await runAntigravityTurn({
    ...opts, agyBin: process.execPath, permissionMode: 'plan',
    acpRunner: async (input) => { applied = input.permissionMode; },
  });
  assert.equal(applied, 'plan');
  assert.equal(submitted, 0);

  let creation;
  await runAntigravityTurn({
    ...opts, isNew: true, model: 'pro',
    bridgeCaller: async (_bridge, pathname, { body }) => {
      creation = { pathname, model: body.model };
      throw new Error('simulated sidecar unavailable');
    },
  });
  assert.deepEqual(creation, { pathname: '/new-conversation', model: 'pro' });
});

test('new Antigravity sessions pass the first-turn model and effort directly to the runner', async () => {
  const member = { key: 'antigravity:first', agent: 'antigravity', providerId: sessionId, cwd: tmpDir() };
  let options;
  const result = await createSession({
    agent: member.agent, cwd: member.cwd, message: '查看项目', model: 'gemini-4-carbon', effort: 'high',
    config: { allowSend: true },
    repo: { listChains: () => [{ members: [member] }], getSession: () => member },
    runner: async ({ model, effort }) => {
      options = { model, effort };
      return { code: 0, summary: { status: 'ok', sessionId, eventCount: 1 } };
    },
    audit() {}, prefs: { set() {} }, push: { send() {} },
    turns: { start() {}, end() {}, latest: () => null }, queue: { list: () => [], takeNext: () => null },
  });
  await result.settled;
  assert.equal(result.body.key, member.key);
  assert.deepEqual(options, { model: 'gemini-4-carbon', effort: 'high' });
});
