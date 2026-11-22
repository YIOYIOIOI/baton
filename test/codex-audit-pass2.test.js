import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildLaunchdPlist,
  buildWindowsStartupScript,
  buildStartArgs,
} from '../scripts/install-autostart.mjs';
import { scanText } from '../scripts/verify-oss-clean.mjs';
import { scanFrom } from '../src/sessioninfo.js';
import { createFollower } from '../src/follow.js';
import { GOAL_CONTINUE, sendMessage } from '../src/http/handlers/turns.js';
import { loadPrincipals } from '../src/principals.js';
import { listQueue } from '../src/runtime/queue.js';
import { listTurns } from '../src/runtime/turns.js';
import { killChildTree, runProcess } from '../src/agent/spawn.js';
import { uploadTarget } from '../src/upload.js';
import { ensureKeys, notify, subscribe, unsubscribe } from '../src/push.js';
import { tmpDir } from './helpers.js';

test('Pass2 #1 #3 #4: install-autostart decodes URL paths, blocks batch injection, forwards PS args, and start-daemon.ps1 parses cleanly', () => {
  const plist = buildLaunchdPlist();
  assert.equal(plist.includes('%20'), false);

  assert.throws(() => buildStartArgs({ host: '127.0.0.1" & echo pwned' }));
  assert.throws(() => buildWindowsStartupScript({ host: '127.0.0.1 & calc' }));

  const cmd = buildWindowsStartupScript({ port: 4100, host: '127.0.0.1', readOnly: true });
  assert.match(cmd, /pwsh\.exe/);
  assert.match(cmd, /-Port 4100/);
  assert.match(cmd, /-HostAddr 127\.0\.0\.1/);
  assert.match(cmd, /-ReadOnly/);

  try {
    const psScript = path.resolve('scripts/start-daemon.ps1').replace(/'/g, "''");
    const out = execFileSync(
      'pwsh',
      [
        '-NoProfile', '-Command',
        `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${psScript}',[ref]$null,[ref]$e); if($e){$e;exit 1}else{'PWSH_OK'}`,
      ],
      { encoding: 'utf8' },
    );
    assert.match(out, /PWSH_OK/);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
});

test('Pass2 #2 & #10: push pins lookup IP in requestImpl, cancels fetch body, and respects timeout', async () => {
  ensureKeys();
  const endpoint = 'https://push.example/pinned-test';
  subscribe({ endpoint }, 'owner', 'push-test-dev002');
  try {
    let resolvedViaLookup = null;
    await notify({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: (opts, cb) => {
        opts.lookup('push.example', { all: false }, (_e, addr, fam) => {
          resolvedViaLookup = `${addr}/${fam}`;
        });
        const handlers = {};
        return {
          setTimeout() {},
          on(ev, fn) { handlers[ev] = fn; },
          end() {
            cb({ statusCode: 201, destroy() {} });
          },
        };
      },
    });
    assert.equal(resolvedViaLookup, '93.184.216.34/4');

    let cancelled = false;
    await notify({
      timeoutMs: 500,
      fetchImpl: async () => ({
        ok: true,
        status: 201,
        body: { async cancel() { cancelled = true; } },
      }),
    });
    assert.equal(cancelled, true);
  } finally {
    unsubscribe(endpoint);
  }
});

test('Pass2 #5: sessioninfo scanFrom reads chunk-straddling JSON without duplication and skips oversized lines', () => {
  const dir = tmpDir('scan-');
  const file = path.join(dir, 't.jsonl');
  const r1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'alpha-chunk' } });
  const huge = JSON.stringify({ type: 'assistant', payload: 'Z'.repeat(512) });
  const r2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'after-huge' } });
  fs.writeFileSync(file, `${r1}\n${huge}\n${r2}\n`);

  const seen = [];
  const end = scanFrom(file, 0, fs.statSync(file).size, (line) => seen.push(JSON.parse(line)), {
    chunkBytes: 17,
    maxLineBytes: 128,
  });
  assert.equal(end, fs.statSync(file).size);
  assert.deepEqual(
    seen.map((x) => x.message.content),
    ['alpha-chunk', 'after-huge'],
  );
});

test('Pass2 #6: goal continuation propagates principalOf so queued guest messages execute cleanly', { timeout: 10000 }, async (t) => {
  const dir = tmpDir('goal-q-');
  const configDir = tmpDir('guest-config-');
  const guestRoot = path.join(configDir, 'workspace');
  fs.symlinkSync(dir, guestRoot, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(configDir, 'principals.json'), JSON.stringify({
    guests: [{ id: 'friend', name: 'Alice', root: guestRoot, allowSend: true }],
  }));
  const { principals, errors } = loadPrincipals({ dir: configDir, manageGenerations: true });
  assert.deepEqual(errors, []);
  const principalOf = (id) => principals.find((p) => p.id === id) ?? null;
  const guest = principalOf('friend');
  const key = 'codex:11111111-1111-4111-8111-111111111111';
  const member = {
    key,
    agent: 'codex',
    providerId: '11111111-1111-4111-8111-111111111111',
    cwd: guestRoot,
    file: path.join(dir, 'empty.jsonl'),
  };
  const ranPrompts = [];
  const continuationStarted = Promise.withResolvers();
  const releaseContinuation = Promise.withResolvers();
  const guestFinished = Promise.withResolvers();
  t.after(() => releaseContinuation.resolve());
  const deps = {
    repo: { getSession: (k) => (k === key ? member : null) },
    config: { allowSend: true },
    principalOf,
    key,
    goalOf: async () => ({ status: ranPrompts.length === 1 ? 'active' : 'completed' }),
    live: () => new Map(),
    push: { send: async () => {} },
    audit: ({ principal, status }) => {
      if (principal === 'friend' && status === 'ok') guestFinished.resolve();
    },
    env: {},
    runner: async ({ message }) => {
      ranPrompts.push(message);
      if (message === GOAL_CONTINUE) {
        continuationStarted.resolve();
        await releaseContinuation.promise;
      }
      return { code: 0, lines: [], summary: { status: 'ok', eventCount: 1 } };
    },
  };
  const first = await sendMessage({ ...deps, principal: principalOf('owner'), message: 'start task' });
  assert.equal(first.body.queued, false);
  await continuationStarted.promise;
  const queued = await sendMessage({ ...deps, principal: guest, message: 'guest follow up' });
  assert.equal(queued.body.queued, true);
  releaseContinuation.resolve();
  await guestFinished.promise;
  assert.deepEqual(ranPrompts, ['start task', GOAL_CONTINUE, 'guest follow up']);
  assert.equal(listQueue(key).length, 0);
  const turn = listTurns(key).find((r) => r.queueId === queued.body.queueId);
  assert.equal(turn.principalId, guest.id);
  assert.equal(turn.principalGeneration, guest.generation);
});

test('Pass2 #7: runProcess bounds retained lines memory while streaming all onLine events', async () => {
  let streamed = 0;
  const r = await runProcess({
    command: process.execPath,
    args: ['-e', '"for(let i=0;i<300;i++)console.log(JSON.stringify({i,pad:\'A\'.repeat(120)}))"'],
    cwd: tmpDir('spawn-cap-'),
    message: '',
    maxRetainedBytes: 2048,
    onLine: () => { streamed += 1; },
  });
  assert.equal(streamed, 300);
  const totalBytes = r.lines.reduce((n, l) => n + l.length, 0);
  assert.ok(totalBytes <= 2048, `retained bytes (${totalBytes}) exceeded cap`);
  assert.ok(r.lines.at(-1)?.includes('"i":299'), 'terminal line must stay retained');
});

test('Pass2 #8: createFollower skips oversized JSONL line beyond maxSingleLineBytes and delivers later events', () => {
  const dir = tmpDir('follow-huge-');
  const file = path.join(dir, 'stream.jsonl');
  const id = '11111111-1111-4111-8111-111111111112';
  const giant = `${JSON.stringify({ type: 'assistant', uuid: 'big', payload: 'X'.repeat(1024) })}\n`;
  const valid = `${JSON.stringify({ type: 'user', sessionId: id, uuid: 'u2', cwd: dir, message: { role: 'user', content: 'after-giant' } })}\n`;
  fs.writeFileSync(file, giant + valid);

  const member = { key: `claude:${id}`, agent: 'claude', providerId: id, file, cwd: dir };
  const got = [];
  const f = createFollower(member, (ev) => got.push(...ev), {
    fromOffset: 0,
    maxChunkBytes: 256,
    maxSingleLineBytes: 512,
  });
  f.tick();
  assert.ok(got.some((e) => e.text === 'after-giant'));
  assert.equal(f.offset, fs.statSync(file).size);
});

test('Pass2 #9: uploadTarget does not follow dangling .baton-uploads/.gitignore symlink outside cwd', () => {
  const dir = tmpDir('upload-sym-');
  const outsideDir = tmpDir('outside-');
  const up = path.join(dir, '.baton-uploads');
  fs.mkdirSync(up, { recursive: true });
  const dangling = path.join(outsideDir, 'pwned-gitignore');
  try {
    fs.symlinkSync(dangling, path.join(up, '.gitignore'));
  } catch {
    return; // Unprivileged Windows without Developer Mode symlink permission: skip cleanly.
  }
  uploadTarget(dir, 'hello.txt');
  assert.equal(fs.existsSync(dangling), false);
});

test('Pass2 #11: verify-oss-clean detects valid tunnel secrets starting with x or X', () => {
  const xSecret = `${'x'}${'A'.repeat(30)}`;
  assert.ok(scanText('config.json', `{"TunnelSecret":"${xSecret}"}`).length > 0);
  const XSecret = `${'X'}${'B'.repeat(30)}`;
  assert.ok(scanText('config.json', `{"TunnelSecret":"${XSecret}"}`).length > 0);
});

test('Pass2 #12: killChildTree falls back to child.kill() for non-positive or missing pid without calling process.kill', () => {
  const origKill = process.kill;
  let osKillCalls = 0;
  let childKillCalls = 0;
  /** @type {any} */ (process).kill = () => {
    osKillCalls += 1;
    return true;
  };
  try {
    const kill = () => { childKillCalls += 1; };
    killChildTree(/** @type {any} */ ({ pid: 0, kill }));
    killChildTree(/** @type {any} */ ({ pid: null, kill }));
    killChildTree(/** @type {any} */ ({ pid: -1, kill }));
    killChildTree(/** @type {any} */ ({ pid: undefined, kill }));
    assert.equal(osKillCalls, 0);
    assert.equal(childKillCalls, 4);
  } finally {
    process.kill = origKill;
  }
});
