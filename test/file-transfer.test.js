import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { OWNER } from '../src/principals.js';
import { openInCwd } from '../src/sessionfs.js';
import { downloadSessionFile, downloadUpload } from '../src/http/handlers/files.js';
import { readUpload, saveUpload } from '../src/upload.js';
import { tmpDir } from './helpers.js';

async function fixture(t, { allowSend = true, maxBodyBytesInFlight = 1024, ...limits } = {}) {
  const cwd = fs.realpathSync.native(tmpDir());
  const guest = { id: 'guest', roots: [cwd], allowSend: true };
  const auth = createAuth({ token: 'fixture-key', principals: [OWNER, guest] });
  const bearer = auth.verifyPair(auth.newPairingCode('guest')).bearer;
  const sessions = new Map([['example', { key: 'example', cwd }]]);
  const repo = { getSession: (key) => sessions.get(key) ?? null };
  const server = createServer({ auth, repo, config: { allowSend }, maxBodyBytesInFlight, ...limits });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { cwd, sessions, server, newCode: () => auth.newPairingCode('guest'),
    base: `http://127.0.0.1:${server.address().port}`, headers: { authorization: `Bearer ${bearer}` } };
}

// A client can send headers before producing any bytes. These checks use a private loopback fixture.
function pending(t, url, headers) {
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(url, { method: 'POST', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('响应在等待正文')));
    req.flushHeaders();
  });
  response.catch(() => {});
  t.after(() => req.destroy());
  return { req, response };
}

test('提问令牌、上传写权限和目标目录在接收正文前验证', async (t) => {
  const disabled = await fixture(t, { allowSend: false });
  const allowed = await fixture(t);
  const outside = tmpDir();
  allowed.sessions.set('gone', { key: 'gone', cwd: path.join(allowed.cwd, 'gone') });
  const cases = [
    [allowed, '/api/ask', 401],
    [disabled, '/api/sessions/example/upload?name=a.txt', 403],
    [allowed, '/api/sessions/missing/upload?name=a.txt', 404],
    [allowed, '/api/sessions/gone/upload?name=a.txt', 400],
    [allowed, `/api/uploads?cwd=${encodeURIComponent(outside)}&name=a.txt`, 403],
  ];
  for (const [f, route, status] of cases) {
    const { response } = pending(t, f.base + route, { ...f.headers, 'Content-Length': '12' });
    assert.equal((await response).status, status);
  }
});

test('分块配对正文超过大小上限后仍可响应并归还配对预算', async (t) => {
  const limit = 1024;
  const f = await fixture(t);
  const post = () => pending(t, f.base + '/api/pair', { 'Transfer-Encoding': 'chunked' });
  const first = post();
  first.req.end(Buffer.alloc(limit + 1));
  assert.equal((await first.response).status, 413);
  const next = post();
  next.req.end('{}');
  const result = await next.response;
  assert.equal(result.status, 400);
  assert.equal(JSON.parse(result.body).error.code, 'bad_pairing_code');
});

test('新手机仍在配对时，已配对设备能同时上传文件', async (t) => {
  const f = await fixture(t, { maxBodyBytesInFlight: 32 });
  const body = JSON.stringify({ code: f.newCode() });
  const arrived = once(f.server, 'request');
  const pairing = pending(t, f.base + '/api/pair', { 'Content-Length': Buffer.byteLength(body) });
  await arrived;
  const saved = await fetch(f.base + '/api/sessions/example/upload?name=note.txt', {
    method: 'POST', headers: f.headers, body: 'saved from my phone',
  });
  assert.equal(saved.status, 201);
  pairing.req.end(body);
  assert.equal((await pairing.response).status, 200);
});

test('配对正文过期后回复 408，仍能用原来的配对码重新配对', async (t) => {
  const f = await fixture(t, { maxPairBodiesInFlight: 1, pairBodyTimeoutMs: 400 });
  const url = f.base + '/api/pair';
  const body = JSON.stringify({ code: f.newCode() });
  const arrived = once(f.server, 'request');
  const slow = pending(t, url, { 'Content-Length': Buffer.byteLength(body) });
  slow.req.write(body.slice(0, 1));
  await arrived;
  const busy = await fetch(url, { method: 'POST', body });
  assert.equal(busy.status, 503);
  assert.equal((await slow.response).status, 408);
  const paired = await fetch(url, { method: 'POST', body });
  assert.equal(paired.status, 200);
});

test('上传共享预算在取消时释放，超出单请求上限时正常回 413', async (t) => {
  const f = await fixture(t, { maxBodyBytesInFlight: 32 });
  const url = f.base + '/api/sessions/example/upload?name=a.txt';
  const arrival = once(f.server, 'request');
  const first = pending(t, url, { ...f.headers, 'Content-Length': '24' });
  const [incoming] = await arrival;
  const busy = await fetch(url, { method: 'POST', headers: f.headers, body: '0123456789abcdef' });
  assert.equal(busy.status, 503);
  const closed = new Promise((resolve) => incoming.once('close', resolve));
  first.req.destroy();
  await closed;
  const large = pending(t, url, { ...f.headers, 'Content-Length': String(32 * 1024 * 1024) });
  assert.equal((await large.response).status, 413);
  const saved = await fetch(url, { method: 'POST', headers: f.headers, body: '0123456789abcdef' });
  assert.equal(saved.status, 201);
  const file = await fetch(url, { headers: f.headers });
  assert.equal(await file.text(), '0123456789abcdef');
  assert.match(file.headers.get('cache-control') ?? '', /no-store/);
  const missing = await fetch(f.base + '/api/sessions/example/upload?name=missing.txt', { headers: f.headers });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('cache-control') ?? '', /no-store/);
});

test('上传期间解除配对，收到最后一段正文时不再写入', async (t) => {
  const f = await fixture(t);
  const arrival = once(f.server, 'request');
  const upload = pending(t, f.base + '/api/sessions/example/upload?name=old.txt', { ...f.headers, 'Content-Length': '2' });
  await arrival;
  const unpair = await fetch(f.base + '/api/unpair', { method: 'POST', headers: f.headers });
  assert.equal(unpair.status, 200);
  upload.req.end('ok');
  assert.equal((await upload.response).status, 401);
  assert.equal(fs.existsSync(path.join(f.cwd, '.baton-uploads', 'old.txt')), false);
});

test('接收 JSON 期间吊销的设备不能再修改会话设置', async (t) => {
  const f = await fixture(t);
  const arrival = once(f.server, 'request');
  const body = JSON.stringify({ model: 'default' });
  const update = pending(t, f.base + '/api/sessions/example/model', { ...f.headers, 'Content-Length': String(Buffer.byteLength(body)) });
  await arrival;
  assert.equal((await fetch(f.base + '/api/unpair', { method: 'POST', headers: f.headers })).status, 200);
  update.req.end(body);
  assert.equal((await update.response).status, 401);
});

test('可变文件下载只传打开时的长度，缩短时仍以完整 HTTP 响应结束', async (t) => {
  const f = await fixture(t);
  for (const [name, next, expected] of [['grow', 'abcd', 'ab'], ['shrink', 'a', 'a'], ['empty', 'new', '']]) {
    const full = path.join(f.cwd, name);
    fs.writeFileSync(full, name === 'empty' ? '' : 'ab');
    const original = fs.createReadStream;
    const hook = t.mock.method(fs, 'createReadStream', (file, options) => {
      fs.writeFileSync(full, next);
      return original(file, options);
    });
    try {
      const res = await fetch(`${f.base}/api/sessions/example/file?path=${name}`, { headers: f.headers });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-length'), null);
      assert.equal(await res.text(), expected);
    } finally { hook.mock.restore(); }
  }
});

test('打开后的文件身份须与工作区授权的文件一致', async (t) => {
  const root = tmpDir();
  const named = path.join(root, 'sample');
  const other = path.join(tmpDir(), 'other');
  fs.writeFileSync(named, 'a');
  fs.writeFileSync(other, 'b');
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (_path, flags) => open(other, flags));
  await assert.rejects(() => openInCwd(root, 'sample'), (err) => err.code === 'OUTSIDE');
});

test('路径检查都返回同一组元数据时，仍须与内核报告的句柄位置交叉核验', async (t) => {
  const root = fs.realpathSync.native(tmpDir());
  const expected = path.join(root, 'expected.txt');
  const other = path.join(tmpDir(), 'other.txt');
  fs.writeFileSync(expected, 'inside');
  fs.writeFileSync(other, 'outside');
  const open = fs.openSync, stat = fs.statSync, lstat = fs.lstatSync;
  t.mock.method(fs, 'openSync', (name, ...args) => open(name === expected ? other : name, ...args));
  t.mock.method(fs, 'statSync', (name, ...args) => stat(name === expected ? other : name, ...args));
  t.mock.method(fs, 'lstatSync', (name, ...args) => lstat(name === expected ? other : name, ...args));
  await assert.rejects(async () => {
    const file = await openInCwd(root, 'expected.txt');
    fs.closeSync(file.fd);
  }, (err) => err.code === 'OUTSIDE');
});

test('访客已授权的会话目录改变时不读取新位置', async () => {
  const guestRoot = fs.realpathSync.native(tmpDir());
  const project = path.join(guestRoot, 'project');
  const moved = fs.realpathSync.native(tmpDir());
  fs.symlinkSync(moved, project, process.platform === 'win32' ? 'junction' : 'dir');
  const repo = { getSession: () => ({ cwd: project }) };
  const principal = { id: 'guest', roots: [guestRoot], realRoots: [guestRoot] };
  const res = { writeHead() { throw new Error('不应开始下载'); } };
  fs.writeFileSync(path.join(moved, 'example.txt'), 'sample');
  saveUpload({ cwd: moved, name: 'example.txt', bytes: Buffer.from('sample') });
  const options = { repo, principal, key: 'sample', res };
  assert.equal((await downloadSessionFile({ ...options, path: 'example.txt' })).status, 403);
  assert.equal((await downloadUpload({ ...options, name: 'example.txt' })).status, 404);
});

test('附件从已验证的 fd 读取，检查大小后增长也不能增加返回的字节数', async (t) => {
  const cwd = tmpDir();
  const attachment = saveUpload({ cwd, name: 'a.txt', bytes: Buffer.from('ab') });
  const read = fs.readSync;
  let first = true;
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    assert.equal(typeof fd, 'number');
    if (first) { first = false; fs.appendFileSync(attachment.path, 'cd'); }
    return read(fd, ...args);
  });
  const value = await readUpload({ cwd, name: 'a.txt', maxBytes: 2 });
  assert.equal(first, false);
  assert.equal(value.bytes.toString(), 'ab');
  assert.equal(value.size, 2);
});

test('附件打开后按句柄重新确认大小', async (t) => {
  const cwd = tmpDir();
  const file = saveUpload({ cwd, name: 'size.txt', bytes: Buffer.from('ab') });
  const stat = fs.statSync;
  let changed = false;
  t.mock.method(fs, 'statSync', (name, ...args) => {
    const info = stat(name, ...args);
    if (!changed && name === file.path) {
      changed = true;
      fs.appendFileSync(name, 'cd');
    }
    return info;
  });
  await assert.rejects(() => readUpload({ cwd, name: 'size.txt', maxBytes: 2 }), (err) => err.code === 'UPLOAD_TOO_LARGE');
});

test('Windows 文件身份核验限制排队数量，已完成的核验释放容量', { skip: process.platform !== 'win32' }, async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'one.txt'), 'one');
  const check = async () => fs.closeSync((await openInCwd(root, 'one.txt')).fd);
  const results = await Promise.allSettled(Array.from({ length: 25 }, check));
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'FILE_CHECK_BUSY');
  await check();
});

test('Windows 文件校验拒绝不合格的宿主路径，即使已有校验进程也不回退', { skip: process.platform !== 'win32' }, async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'one.txt'), 'one');
  const prior = process.env.BATON_PWSH7;
  try {
    for (const selected of ['pwsh.exe', path.join(root, 'powershell.exe'), path.join(root, 'missing', 'pwsh.exe')]) {
      process.env.BATON_PWSH7 = selected;
      await assert.rejects(() => openInCwd(root, 'one.txt'), (err) => err.code === 'FILE_CHECK_UNAVAILABLE');
    }
  } finally {
    if (prior === undefined) delete process.env.BATON_PWSH7;
    else process.env.BATON_PWSH7 = prior;
  }
});

test('Windows 文件 ID 不可用时按继承的原句柄核实位置，原句柄仍可正常读取', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fs.realpathSync.native(tmpDir());
  const name = '图样.txt';
  const named = path.join(root, name);
  const other = path.join(tmpDir(), name);
  fs.writeFileSync(named, 'example');
  fs.writeFileSync(other, 'other');
  // Some file systems do not provide comparable volume and inode numbers.
  for (const method of ['statSync', 'fstatSync', 'lstatSync']) {
    const stat = fs[method];
    t.mock.method(fs, method, (...args) => {
      const value = stat(...args);
      if (args[1]?.bigint) { value.dev = 0n; value.ino = 0n; }
      return value;
    });
  }
  const file = await openInCwd(root, name);
  try { assert.equal(fs.readFileSync(file.fd, 'utf8'), 'example'); }
  finally { fs.closeSync(file.fd); }
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (p, ...args) => open(p === named ? other : p, ...args));
  await assert.rejects(() => openInCwd(root, name), (err) => err.code === 'OUTSIDE');
});
