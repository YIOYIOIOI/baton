import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listInCwd, resolveInCwd } from '../src/sessionfs.js';

// 会话建在盘根（`C:\`，posix 上是 `/`）时，工作目录本身就以分隔符结尾。
// 包含性校验原来写的是 `root + sep`，拼出 `C:\\`，盘根下任何东西都不以它开头——
// 文件浏览器进根能看到一层，点进任何一个文件夹都报「不在工作目录里」。

const tmp = fs.realpathSync(os.tmpdir());
const fsRoot = path.parse(tmp).root;
const first = path.relative(fsRoot, tmp).split(path.sep)[0];

test('盘根做工作目录：能进下一层', () => {
  assert.ok(first, '临时目录不该就是盘根');
  const r = listInCwd(fsRoot, first);
  assert.equal(r.path, first);
  assert.equal(r.parent, '');
});

test('盘根做工作目录：解析出来的相对路径用正斜杠', () => {
  const r = resolveInCwd(fsRoot, path.relative(fsRoot, tmp));
  assert.equal(r.full, tmp);
  assert.equal(r.relative, path.relative(fsRoot, tmp).split(path.sep).join('/'));
});

test('普通工作目录：同名前缀的兄弟目录仍然算越界', () => {
  const base = fs.mkdtempSync(path.join(tmp, 'baton-fs-'));
  const work = path.join(base, 'work');
  const sibling = path.join(base, 'work2');
  fs.mkdirSync(work);
  fs.mkdirSync(sibling);
  try {
    assert.throws(() => resolveInCwd(work, '../work2'), (e) => e.code === 'OUTSIDE');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
