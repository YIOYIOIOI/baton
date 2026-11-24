import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { resolveInCwd, listInCwd, openInCwd } from '../src/sessionfs.js';
import { downloadSessionFile } from '../src/http/handlers/files.js';
import { tmpDir } from './helpers.js';

/** 打开之后读出来、关掉。路径安全那几条关心的是「打开的是不是这个文件」。 */
async function readInCwd(cwd, rel) {
  const f = await openInCwd(cwd, rel);
  try {
    return { ...f, bytes: fs.readFileSync(f.fd) };
  } finally {
    fs.closeSync(f.fd);
  }
}

const tmp = (p) => tmpDir(p);

/**
 * 搭一棵小树：
 *
 *   <cwd>/
 *     a.txt            "A"
 *     .hidden          "H"        点开头的也要列出来
 *     sub/
 *       b.txt          "B"
 *     .git/
 *       config         "GIT"
 *   <cwd 的兄弟>/secret.txt  "NO"  —— 这个必须够不着
 */
function tree() {
  const base = tmp('baton-fs-');
  const cwd = path.join(base, 'work');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'A');
  fs.writeFileSync(path.join(cwd, '.hidden'), 'H');
  fs.writeFileSync(path.join(cwd, 'sub', 'b.txt'), 'B');
  fs.writeFileSync(path.join(cwd, '.git', 'config'), 'GIT');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'NO');
  return { base, cwd };
}

// ── 边界 ────────────────────────────────────────

/**
 * **这一组是这个模块存在的理由。**
 *
 * 它新开了一个读取面，所以「能碰到的恰好等于这个会话的工作目录子树」这句话
 * 必须由测试来保证，而不是由注释保证。
 */
test('穿不出工作目录：各种写法一律拒绝', () => {
  const { base, cwd } = tree();
  for (const attack of [
    '../secret.txt',
    '..\\secret.txt',
    'sub/../../secret.txt',
    '../../etc/passwd',
    path.join(base, 'secret.txt'), // 绝对路径
  ]) {
    assert.throws(() => resolveInCwd(cwd, attack), undefined, `${attack} 不该读到`);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * 绝对路径不是"直接用"，而是**先归一化到子树里再判**。
 *
 * `path.resolve(root, '/x')` 在 POSIX 上得到 `/x`（越界，会被拒），而在 Windows 上
 * 得到 `<盘符>/x`——两种都不在 root 下，所以两边都拒。这条钉的是「不会因为平台
 * 差异悄悄放行」。
 */
test('前导斜杠被当成相对根，而不是文件系统根', async () => {
  const { base, cwd } = tree();
  // `/a.txt` 应当解析成 cwd 下的 a.txt，而不是系统根下的
  assert.equal((await readInCwd(cwd, '/a.txt')).bytes.toString(), 'A');
  fs.rmSync(base, { recursive: true, force: true });
});

test('反斜杠和正斜杠都收——agent 写出来的两种都有', async () => {
  const { base, cwd } = tree();
  assert.equal((await readInCwd(cwd, 'sub/b.txt')).bytes.toString(), 'B');
  assert.equal((await readInCwd(cwd, 'sub\\b.txt')).bytes.toString(), 'B');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── 列目录 ──────────────────────────────────────

test('目录在前、文件在后，点开头的也列出来', () => {
  const { base, cwd } = tree();
  const r = listInCwd(cwd, '');
  assert.equal(r.path, '');
  assert.equal(r.parent, null, '工作目录就是天花板，不给往上走');
  assert.deepEqual(r.entries.map((e) => e.name), ['.git', 'sub', '.hidden', 'a.txt']);
  assert.deepEqual(r.entries.map((e) => e.dir), [true, true, false, false]);
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * **不藏 .git / node_modules。**
 *
 * 藏起来只会让人以为文件丢了，而这棵树上的东西本来就是那个 agent 随时能读的——
 * 藏了也只是自欺。owner 明确选了「所有东西都要支持下载」。
 */
test('.git 里的东西照列照读', async () => {
  const { base, cwd } = tree();
  assert.ok(listInCwd(cwd, '.git').entries.some((e) => e.name === 'config'));
  assert.equal((await readInCwd(cwd, '.git/config')).bytes.toString(), 'GIT');
  fs.rmSync(base, { recursive: true, force: true });
});

test('进子目录时 parent 指回上一层，到顶为 null', () => {
  const { base, cwd } = tree();
  assert.equal(listInCwd(cwd, 'sub').parent, '', 'sub 的上一层是工作目录本身');
  assert.equal(listInCwd(cwd, '').parent, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('文件给大小、目录不给', () => {
  const { base, cwd } = tree();
  const e = listInCwd(cwd, '').entries;
  assert.equal(e.find((x) => x.name === 'a.txt').size, 1);
  assert.equal(e.find((x) => x.name === 'sub').size, null);
  fs.rmSync(base, { recursive: true, force: true });
});

// ── 读文件 ──────────────────────────────────────

test('把目录当文件读要报出来，不能返回一坨乱七八糟的东西', async () => {
  const { base, cwd } = tree();
  await assert.rejects(() => readInCwd(cwd, 'sub'), (e) => e.code === 'ISDIR');
  fs.rmSync(base, { recursive: true, force: true });
});

test('把文件当目录列也一样', () => {
  const { base, cwd } = tree();
  assert.throws(() => listInCwd(cwd, 'a.txt'), (e) => e.code === 'NOTDIR');
  fs.rmSync(base, { recursive: true, force: true });
});

test('不存在就抛，交给上层转 404', async () => {
  const { base, cwd } = tree();
  await assert.rejects(() => readInCwd(cwd, '没有这个.txt'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('没有工作目录的会话直接拒绝', () => {
  assert.throws(() => resolveInCwd(null, 'a.txt'), /没有工作目录/);
});

// ── 下载：一段一段流出去，不整个读进内存（2026-10-01 审查）──────────────

test('downloadSessionFile：大文件分段发送，以实际流量结束响应', async () => {
  // 工作目录里什么都可能有：数据库、视频、构建产物。原来 readFileSync 整个读进来，
  // 1.5 GB 的文件就是 1.5 GB 内存，读的时候整个守护进程卡住；超过 2 GB 还会报错成 404
  const cwd = tmp('baton-dl-');
  const big = Buffer.alloc(5 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(cwd, 'big.bin'), big);
  const chunks = [];
  let head = null;
  const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
  res.writeHead = (status, headers) => { head = { status, headers }; };
  const done = new Promise((r) => res.on('finish', r));
  const repo = { getSession: () => ({ cwd }) };
  assert.equal(await downloadSessionFile({ repo, key: 'K', path: 'big.bin', res }), null);
  await done;
  assert.equal(head.status, 200);
  assert.equal(head.headers['Content-Length'], undefined);
  assert.ok(chunks.length > 1, `应当分段写出，实际 ${chunks.length} 段`);
  assert.ok(Buffer.concat(chunks).equals(big));
  fs.rmSync(cwd, { recursive: true, force: true });
});
