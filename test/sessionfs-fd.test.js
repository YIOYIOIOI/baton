import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openInCwd } from '../src/sessionfs.js';
import { tmpDir } from './helpers.js';

// openInCwd 先 open 再 fstat。fstat 抛了的话，原来那个 fd 就没人关了——调用方
// 什么都没拿到。守护进程常驻，漏的句柄只增不减。

test('fstat 抛错时刚打开的句柄会被关掉，错误照原样抛出', async (t) => {
  const dir = fs.realpathSync(tmpDir());
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  const boom = Object.assign(new Error('fstat 坏了'), { code: 'EIO' });
  t.mock.method(fs, 'fstatSync', () => { throw boom; });
  const closed = [];
  const realClose = fs.closeSync;
  t.mock.method(fs, 'closeSync', (fd) => { closed.push(fd); return realClose(fd); });
  const opened = [];
  const realOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (...args) => { const fd = realOpen(...args); opened.push(fd); return fd; });

  await assert.rejects(() => openInCwd(dir, 'a.txt'), (e) => e === boom);
  assert.equal(opened.length, 1);
  assert.deepEqual(closed, opened, '打开的那个 fd 必须被关掉');
});

test('正常路径上 fd 交给调用方，不提前关', async () => {
  const dir = fs.realpathSync(tmpDir());
  fs.writeFileSync(path.join(dir, 'b.txt'), 'hello');
  const r = await openInCwd(dir, 'b.txt');
  try {
    assert.equal(r.size, 5);
    assert.equal(fs.readFileSync(r.fd, 'utf8'), 'hello');
  } finally {
    fs.closeSync(r.fd);
  }
});
