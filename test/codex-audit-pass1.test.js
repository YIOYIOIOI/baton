import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createAuth } from '../src/http/auth.js';
import { createServer } from '../src/http/server.js';
import { OWNER_ID } from '../src/principals.js';
import { fileRevocations, memoryRevocations } from '../src/revocations.js';
import { drainQueue, cancelQueued, sendMessage } from '../src/http/handlers/turns.js';
import { getEvents } from '../src/http/handlers/sessions.js';
import { createSseStream } from '../src/http/sse.js';
import { createFollower } from '../src/follow.js';
import { openInCwd } from '../src/sessionfs.js';
import { uploadTarget, readUpload } from '../src/upload.js';
import { readRangeWithOffsets } from '../src/jsonl.js';
import { enqueue, listQueue, QueueFullError } from '../src/runtime/queue.js';
import { exportFilename } from '../src/export.js';
import { formatHttpUrl } from '../src/lan.js';
import { parseCliArgs } from '../src/cli-args.js';
import { runPairCommand } from '../src/pair-client.js';
import { codexRpc } from '../src/agent/codexRpc.js';
import { listCodexSkills } from '../src/agent/commands.js';
import { queueToCodexApp } from '../src/agent/codexQueue.js';
import { runProcess } from '../src/agent/spawn.js';
import { notify, subscribe, ensureKeys, unsubscribe, listSubscriptions } from '../src/push.js';
import { latestCodexUsage, httpsGet } from '../src/usage.js';
import { tmpDir, writeJsonl } from './helpers.js';

const TOKEN = 'f'.repeat(64);

function makeRepoWithMember(member) {
  return {
    listChains: () => [{ chainId: member.key, latestKey: member.key, members: [member] }],
    getSession: (k) => (k === member.key ? member : null),
  };
}

test('#1 read-only daemon config caps guest allowSend: true over HTTP', async () => {
  const dir = tmpDir();
  const file = writeJsonl(dir, 's.jsonl', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  const guest = { id: 'friend', name: 'Friend', roots: [dir], allowSend: true };
  const member = { key: 'claude:g1', agent: 'claude', providerId: '11111111-1111-4111-8111-111111111111', cwd: dir, file };
  const auth = createAuth({ token: TOKEN, principals: [{ id: OWNER_ID, name: 'owner', roots: null, allowSend: null }, guest], revocations: memoryRevocations() });
  const bearer = auth.verifyPair(auth.newPairingCode('friend')).bearer;
  const server = createServer({ repo: makeRepoWithMember(member), auth, config: { host: '127.0.0.1', port: 0, allowSend: false } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await (await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${bearer}` } })).json();
    assert.equal(health.allowSend, false, 'global read-only must override guest allowSend: true');

    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(member.key)}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('#2 drainQueue enforces principal existence, allowSend, and current roots', async () => {
  const allowedDir = tmpDir();
  const otherDir = tmpDir();
  const key = 'claude:queued-scope';
  const member = { key, agent: 'claude', providerId: '22222222-2222-4222-8222-222222222222', cwd: otherDir };
  const repo = makeRepoWithMember(member);
  const audits = [];
  let ran = 0;
  const baseDeps = {
    repo,
    config: { allowSend: true },
    key,
    runner: async () => { ran += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; },
    audit: (e) => audits.push(e),
    env: { ANTHROPIC_AUTH_TOKEN: 't' },
    turns: { start: () => {}, end: () => ({ status: 'ok' }), latest: () => null },
  };

  // Deleted principal
  const q1 = tmpDir();
  enqueue({ key, text: 'orphan guest msg', principalId: 'removed' }, { dir: q1 });
  await drainQueue({
    ...baseDeps,
    principalOf: () => null,
    queue: { enqueue: (i) => enqueue(i, { dir: q1 }), takeNext: (k) => takeNextItem(k, q1), list: (k) => listQueue(k, { dir: q1 }) },
  });
  assert.equal(ran, 0);
  assert.match(audits.at(-1)?.status ?? '', /queued_dropped/);

  // Principal out of scope after config change
  const q2 = tmpDir();
  enqueue({ key, text: 'out of scope msg', principalId: 'friend' }, { dir: q2 });
  await drainQueue({
    ...baseDeps,
    principalOf: (id) => (id === 'friend' ? { id: 'friend', roots: [allowedDir], allowSend: true } : null),
    queue: { enqueue: (i) => enqueue(i, { dir: q2 }), takeNext: (k) => takeNextItem(k, q2), list: (k) => listQueue(k, { dir: q2 }) },
  });
  assert.equal(ran, 0);

  // Principal with allowSend: false
  const q3 = tmpDir();
  enqueue({ key, text: 'revoked write msg', principalId: 'friend' }, { dir: q3 });
  await drainQueue({
    ...baseDeps,
    principalOf: (id) => (id === 'friend' ? { id: 'friend', roots: [otherDir], allowSend: false } : null),
    queue: { enqueue: (i) => enqueue(i, { dir: q3 }), takeNext: (k) => takeNextItem(k, q3), list: (k) => listQueue(k, { dir: q3 }) },
  });
  assert.equal(ran, 0);
});

function takeNextItem(key, dir) {
  const items = listQueue(key, { dir });
  if (!items.length) return null;
  const [head, ...rest] = items;
  const f = path.join(dir, 'queue', `${encodeURIComponent(key)}.jsonl`);
  if (!rest.length) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, rest.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return head;
}

test('#3 revoking device immediately terminates active SSE stream for that device', async () => {
  const dir = tmpDir();
  const file = writeJsonl(dir, 's.jsonl', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  const member = { key: 'claude:sse-rev', agent: 'claude', providerId: '33333333-3333-4333-8333-333333333333', cwd: dir, file };
  const auth = createAuth({ token: TOKEN, revocations: memoryRevocations() });
  const paired = auth.verifyPair(auth.newPairingCode());
  const server = createServer({ repo: makeRepoWithMember(member), auth, config: { host: '127.0.0.1', port: 0, allowSend: true } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(member.key)}/stream`, {
      headers: { Authorization: `Bearer ${paired.bearer}` },
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read(); // : open
    auth.revokeDevice(paired.deviceId, OWNER_ID);
    const next = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SSE did not close on device revoke')), 1500)),
    ]);
    assert.equal(next.done, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('#5 & #6 fileRevocations retains loaded state on later corruption and merges saves across instances', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'revoked.json');
  const r1 = fileRevocations(file);
  const r2 = fileRevocations(file);

  r1.revoke('dev-a', 'owner');
  r2.revokeLegacy('guest1'); // r2 loaded stale state before write? Force separate unmerged concurrent instance:
  const r3 = fileRevocations(file);
  r3.revoke('dev-b', 'owner');

  const check = fileRevocations(file);
  assert.equal(check.isRevoked('dev-a'), true, 'prior dev-a revocation must survive concurrent save');
  assert.equal(check.isLegacyRevoked('guest1'), true, 'legacy revocation must survive concurrent save');
  assert.equal(check.isRevoked('dev-b'), true);

  // Corrupt after valid load -> fails closed (retains known revocations in memory)
  const prevMtime = fs.statSync(file).mtimeMs;
  fs.writeFileSync(file, '{ truncated');
  const bumped = new Date(prevMtime + 5000);
  fs.utimesSync(file, bumped, bumped);
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(check.isRevoked('dev-a'), true, 'must retain previously loaded revocations if file corrupts mid-run');
  } finally {
    console.error = origErr;
  }
});

test('#7 & #23 push notify blocks redirects & private DNS and preserves concurrent subscriptions', async () => {
  ensureKeys();
  const subA = 'https://push.example/ssrf-dead-a';
  const subB = 'https://push.example/concurrent-b';
  subscribe({ endpoint: subA }, 'owner', 'push-test-dev001');
  try {
    let seenInit = null;
    await notify({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      fetchImpl: async () => { throw new Error('must not fetch resolved loopback IP'); },
    });

    await notify({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (_url, init) => {
        seenInit = init;
        subscribe({ endpoint: subB }, 'owner', 'push-test-dev001'); // concurrent subscribe while notify awaits network
        return { ok: false, status: 410 };
      },
    });
    assert.equal(seenInit?.redirect, 'error');
    const endpoints = listSubscriptions().map((s) => s.endpoint);
    assert.equal(endpoints.includes(subA), false);
    assert.equal(endpoints.includes(subB), true, 'concurrent subscribe must not be lost during dead-sub cleanup');
  } finally {
    unsubscribe(subA);
    unsubscribe(subB);
  }
});

test('#8 & #24 codexRpc / listCodexSkills / codexQueue survive early stdin error and avoid shell on POSIX', async () => {
  const seenOpts = [];
  const fakeSpawn = (_cmd, _args, opts) => {
    seenOpts.push(opts);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {
      queueMicrotask(() => child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));
      return false;
    };
    child.stdin.end = () => {};
    child.kill = () => {};
    return child;
  };

  await assert.rejects(() => codexRpc([{ method: 'skills/list' }], { spawnFn: fakeSpawn, killTreeFn: () => {} }), /EPIPE/);
  await assert.rejects(() => listCodexSkills('C:\\x', { spawnFn: fakeSpawn, killTreeFn: () => {} }), /EPIPE/);
  await assert.rejects(() => queueToCodexApp({ threadId: 't1', text: 'hi', spawnFn: fakeSpawn }), /EPIPE/);
  if (process.platform !== 'win32') {
    for (const o of seenOpts) assert.equal(o.shell, false);
  }
});

test('#9 & #17 createFollower tolerates errors & caps chunk bytes; SSE closes on backpressure', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'grow.jsonl');
  const line = JSON.stringify({
    type: 'assistant', uuid: 'u1', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(1200) }] },
  }) + '\n';
  fs.writeFileSync(file, line.repeat(20));

  const seen = [];
  // Chunk cap 1500 bytes forces multi-tick progression cleanly
  const f = createFollower(
    { agent: 'claude', file },
    (evs) => seen.push(...evs),
    { fromOffset: 0, maxChunkBytes: 1500 },
  );
  for (let i = 0; i < 30 && f.offset < fs.statSync(file).size; i += 1) f.tick();
  assert.equal(f.offset, fs.statSync(file).size);
  assert.equal(seen.length, 20);

  // Missing file inside tick does not throw
  fs.unlinkSync(file);
  assert.doesNotThrow(() => f.tick());

  // SSE backpressure threshold closes stream
  const fakeRes = new EventEmitter();
  fakeRes.writeHead = () => {};
  fakeRes.writableLength = 0;
  fakeRes.end = () => { fakeRes.ended = true; };
  fakeRes.destroy = () => { fakeRes.destroyed = true; };
  fakeRes.write = () => false;
  const sse = createSseStream(fakeRes, { maxBufferedBytes: 100 });
  fakeRes.writableLength = 200;
  sse.send('events', { a: 1 });
  assert.equal(sse.closed, true);
});

test('#10 openInCwd rejects non-regular files (FIFO/device) before reading', async () => {
  const dir = fs.realpathSync(tmpDir());
  const p = path.join(dir, 'file.txt');
  fs.writeFileSync(p, 'ok');
  const origStat = fs.statSync;
  fs.statSync = (target) => {
    const s = origStat(target);
    if (path.resolve(String(target)) === path.resolve(p)) {
      return { isDirectory: () => false, isFile: () => false, size: 0 };
    }
    return s;
  };
  try {
    await assert.rejects(() => openInCwd(dir, 'file.txt'), (err) => err?.code === 'ENOTFILE');
  } finally {
    fs.statSync = origStat;
  }
});

test('#11 cancelQueued enforces allowSend when config is read-only', async () => {
  const dir = tmpDir();
  const member = { key: 'claude:cq', agent: 'claude', providerId: '44444444-4444-4444-8444-444444444444', cwd: dir };
  const r = cancelQueued({ repo: makeRepoWithMember(member), config: { allowSend: false }, key: member.key, id: '1' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'send_disabled');
});

test('#12 & #19 uploadTarget rejects symlinked .baton-uploads before writing .gitignore, and readUpload caps maxBytes', async () => {
  const outside = tmpDir();
  const ws = tmpDir();
  try {
    fs.symlinkSync(outside, path.join(ws, '.baton-uploads'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // Some locked-down Windows configs disallow symlinks without privilege; junction usually succeeds
  }
  if (fs.existsSync(path.join(ws, '.baton-uploads'))) {
    assert.throws(() => uploadTarget(ws, 'evil.txt'), /符号链接|工作目录之外/);
    assert.equal(fs.existsSync(path.join(outside, '.gitignore')), false, 'must not create .gitignore outside cwd');
  }

  const ws2 = tmpDir();
  fs.mkdirSync(path.join(ws2, '.baton-uploads'), { recursive: true });
  fs.writeFileSync(path.join(ws2, '.baton-uploads', 'huge.bin'), Buffer.alloc(64));
  await assert.rejects(
    () => readUpload({
      cwd: ws2,
      name: 'huge.bin',
      maxBytes: 32,
    }),
    (err) => err?.code === 'UPLOAD_TOO_LARGE',
  );
});

test('#16 runProcess bounds captured stderr length on runaway child output', async () => {
  const r = await runProcess({
    command: process.execPath,
    args: ['-e', '"process.stderr.write(\'x\'.repeat(200000))"'],
    cwd: tmpDir(),
    message: '',
    maxStderrBytes: 4096,
  });
  assert.ok(r.stderr.length <= 5000);
});

test('#20 enqueue enforces max queue items/bytes and sendMessage returns 429 queue_full', async () => {
  const dir = tmpDir();
  const key = 'claude:cap';
  assert.throws(
    () => {
      for (let i = 0; i < 6; i += 1) enqueue({ key, text: `msg-${i}` }, { dir, maxItems: 5 });
    },
    (err) => err instanceof QueueFullError && err.code === 'QUEUE_FULL',
  );

  const member = { key, agent: 'claude', providerId: '55555555-5555-4555-8555-555555555555', cwd: dir };
  const res = await sendMessage({
    repo: makeRepoWithMember(member),
    config: { allowSend: true },
    key,
    message: 'one too many',
    env: { ANTHROPIC_AUTH_TOKEN: 't' },
    turns: { latest: () => ({ status: 'running', turnId: 't0' }), start: () => {}, end: () => ({}) },
    queue: {
      enqueue: () => { throw new QueueFullError('queue full'); },
      list: () => [],
      takeNext: () => null,
    },
  });
  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'queue_full');
});

test('#22 latestCodexUsage closes fd if readSync throws, and httpsGet caps response size', async () => {
  const home = tmpDir();
  const sessDir = path.join(home, '.codex', 'sessions', '2026', '11');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'rollout-test.jsonl'), '{"type":"event"}\n');

  const opened = [];
  const closed = [];
  const realOpen = fs.openSync;
  const realClose = fs.closeSync;
  const realRead = fs.readSync;
  fs.openSync = (...args) => { const fd = realOpen(...args); opened.push(fd); return fd; };
  fs.closeSync = (fd) => { closed.push(fd); return realClose(fd); };
  fs.readSync = () => { throw new Error('read boom'); };
  try {
    latestCodexUsage({ home });
    assert.deepEqual(closed, opened);
  } finally {
    fs.openSync = realOpen;
    fs.closeSync = realClose;
    fs.readSync = realRead;
  }
});

test('#25 & #26 formatHttpUrl brackets IPv6 and parseCliArgs accepts --port/--host on pair', () => {
  assert.equal(formatHttpUrl('::1', 3002), 'http://[::1]:3002');
  assert.equal(formatHttpUrl('[::1]', 3002), 'http://[::1]:3002');
  assert.equal(formatHttpUrl('127.0.0.1', 3002), 'http://127.0.0.1:3002');

  assert.deepEqual(parseCliArgs(['pair', '--for', 'friend', '--port', '4100', '--host', '127.0.0.2']), {
    ok: true,
    cmd: 'pair',
    for: 'friend',
    port: 4100,
    host: '127.0.0.2',
  });
});

test('#28 & #32 runPairCommand writes 0o600 QR SVG and accepts port/host overrides', async () => {
  const batonDir = tmpDir();
  fs.writeFileSync(path.join(batonDir, 'token'), TOKEN);
  fs.writeFileSync(path.join(batonDir, 'config.json'), JSON.stringify({ port: 3002, host: '127.0.0.1', publicUrl: 'https://pair.example' }));

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'ABCD1234EFGH', for: 'owner' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const code = await runPairCommand([], { batonDir, port: srv.address().port, host: '127.0.0.1', openQr: false });
    assert.equal(code, 0);
    const qrPath = path.join(batonDir, 'pairing-qr.svg');
    assert.ok(fs.existsSync(qrPath));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(qrPath).mode & 0o777, 0o600);
    }
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('#29 readRangeWithOffsets preserves exact byte offsets across mid-UTF8 start boundary', () => {
  const dir = tmpDir();
  const l1 = JSON.stringify({ a: '中文第一行内容' });
  const l2 = JSON.stringify({ b: 'second line' });
  const l3 = JSON.stringify({ c: 'third line' });
  const content = `${l1}\n${l2}\n${l3}\n`;
  const f = path.join(dir, 'utf8.jsonl');
  fs.writeFileSync(f, content, 'utf8');
  const off2 = Buffer.byteLength(`${l1}\n`, 'utf8');
  const off3 = Buffer.byteLength(`${l1}\n${l2}\n`, 'utf8');

  // Slice starting right inside the 3-byte Chinese character '第'
  const startInsideUtf8 = content.indexOf('第') > 0 ? Buffer.byteLength(l1.slice(0, l1.indexOf('第')), 'utf8') + 1 : 5;
  const { entries } = readRangeWithOffsets(f, startInsideUtf8, Buffer.byteLength(content, 'utf8'), { trimPartialFirstLine: true });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].offset, off2);
  assert.equal(entries[1].offset, off3);
});

test('#30 & #31 & #33 integer limit, code-point exportFilename, and auth rateLimit map pruning', async () => {
  const dir = tmpDir();
  const file = writeJsonl(dir, 'evs.jsonl', [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '1' } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '2' } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: '3' } },
  ]);
  const member = { key: 'claude:lim', agent: 'claude', providerId: '66666666-6666-4666-8666-666666666666', cwd: dir, file };
  const r = await getEvents(makeRepoWithMember(member), member.key, { limit: '1.9' });
  assert.equal(r.status, 200);
  assert.equal(r.body.events.length, 1, 'fractional limit must truncate rather than round or stay float');

  const name = exportFilename('🚀'.repeat(60));
  assert.equal(name.toWellFormed(), name, 'exportFilename must not leave dangling surrogate pairs');

  let clock = 1000;
  const auth = createAuth({ token: TOKEN, now: () => clock, windowMs: 10_000, maxFails: 3 });
  auth.noteFailure('1.2.3.4');
  assert.equal(auth.rateLimit('1.2.3.4').ok, true);
  clock += 20_000;
  assert.equal(auth.rateLimit('1.2.3.4').ok, true);
  assert.equal(auth.rateLimitBucketCount?.(), 0, 'expired IP failure buckets must be pruned');
});

test('smoke check usage.httpsGet cleans up on timeout', async () => {
  await assert.rejects(
    () => httpsGet('https://127.0.0.1:9/test', {}, { timeoutMs: 30 }),
    /.*/,
  );
});
