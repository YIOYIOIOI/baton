import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listDirs, listDrives } from '../src/dirs.js';
import { browseDirs, makeDir } from '../src/http/handlers/dirs.js';
import { tmpDir } from './helpers.js';

const OWNER_P = { id: 'owner', name: 'owner', roots: null, allowSend: null };
const emptyRepo = { listChains: () => [], getSession: () => null, stats: () => ({}) };

function fixture() {
  const base = tmpDir();
  fs.mkdirSync(path.join(base, 'alpha'));
  fs.mkdirSync(path.join(base, 'beta'));
  fs.writeFileSync(path.join(base, 'note.txt'), 'x');
  return base;
}

test('listDirs 只返回目录，不返回文件', () => {
  const base = fixture();
  const names = listDirs(base).map((d) => d.name);
  assert.deepEqual(names, ['alpha', 'beta']);
  assert.equal(names.includes('note.txt'), false, '文件树是 spec §18 明确不做的');
});

test('listDrives 总是非空', () => {
  // owner 的起点页面绝不能是空的
  assert.ok(listDrives().length >= 1);
});

test('读不动的子目录标 readable:false，但请求照常成功', () => {
  // owner 的无限制视图里一定会遇到 C:\System Volume Information、$Recycle.Bin 这类。
  // 它们绝不能让整个请求 500——那样 owner 连自己的盘都浏览不了。
  // probe 注入是因为在测试里造一个真正读不动的目录不可移植。
  const base = fixture();
  const dirs = listDirs(base, { probe: () => false });
  assert.equal(dirs.length, 2);
  assert.deepEqual(dirs.map((d) => d.readable), [false, false]);
});

test('browseDirs：guest 越界返回 403 且告诉他边界在哪', () => {
  const base = fixture();
  const guest = { id: 'friend', roots: [path.join(base, 'alpha')] };
  const r = browseDirs({ repo: emptyRepo, principal: guest, path: path.join(base, 'beta') });
  assert.equal(r.status, 403);
  assert.match(r.body.error.fix, /alpha/, 'fix 必须说出他的工作区在哪');
});

test('browseDirs：guest 的起点只有自己的 root，且不给往上走的入口', () => {
  const base = fixture();
  const root = path.join(base, 'alpha');
  const guest = { id: 'friend', roots: [root] };

  const start = browseDirs({ repo: emptyRepo, principal: guest, path: null });
  assert.equal(start.body.path, null);
  assert.equal(start.body.parent, null);
  assert.deepEqual(start.body.dirs.map((d) => d.path), [root]);

  const at = browseDirs({ repo: emptyRepo, principal: guest, path: root });
  assert.equal(at.status, 200);
  assert.equal(at.body.parent, null, '站在自己 root 上时没有 parent');
});

test('browseDirs：owner 能进任意目录，并有 parent', () => {
  const base = fixture();
  const r = browseDirs({ repo: emptyRepo, principal: OWNER_P, path: path.join(base, 'alpha') });
  assert.equal(r.status, 200);
  assert.equal(r.body.parent, base);
});

test('browseDirs：owner 的起点含盘符', () => {
  const r = browseDirs({ repo: emptyRepo, principal: OWNER_P, path: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.path, null);
  assert.ok(r.body.dirs.length >= 1);
});

test('browseDirs：目录不存在返回 404', () => {
  const r = browseDirs({ repo: emptyRepo, principal: OWNER_P, path: path.join(tmpDir(), 'nope') });
  assert.equal(r.status, 404);
  assert.ok(r.body.error.fix);
});

test('browseDirs：相对路径返回 400', () => {
  const r = browseDirs({ repo: emptyRepo, principal: OWNER_P, path: 'relative' });
  assert.equal(r.status, 400);
});

test('makeDir：allowSend 关闭时 403 且指出配置文件与字段', () => {
  const r = makeDir({
    config: { allowSend: false }, principal: OWNER_P, path: path.join(tmpDir(), 'x'),
  });
  assert.equal(r.status, 403);
  assert.match(r.body.error.fix, /config\.json/);
  assert.match(r.body.error.fix, /allowSend/);
});

test('makeDir：递归建出多层，返回 201', () => {
  const target = path.join(tmpDir(), 'a', 'b', 'c');
  const r = makeDir({ config: { allowSend: true }, principal: OWNER_P, path: target });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, true);
  assert.equal(fs.existsSync(target), true);
});

test('makeDir：已存在的目录返回 200 created:false，不当错误', () => {
  const target = tmpDir();
  const r = makeDir({ config: { allowSend: true }, principal: OWNER_P, path: target });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, false);
});

test('makeDir：路径上已存在同名文件时 400', () => {
  const base = fixture();
  const r = makeDir({
    config: { allowSend: true }, principal: OWNER_P, path: path.join(base, 'note.txt'),
  });
  assert.equal(r.status, 400);
});

test('makeDir：guest 越界返回 403，且一个目录都不建', () => {
  const base = tmpDir();
  const guest = { id: 'friend', roots: [path.join(base, 'alpha')] };
  const r = makeDir({
    config: { allowSend: true }, principal: guest, path: path.join(base, 'beta'),
  });
  assert.equal(r.status, 403);
  assert.equal(fs.existsSync(path.join(base, 'beta')), false);
});

test('makeDir：guest 在自己 root 之下可以建', () => {
  const base = tmpDir();
  const root = path.join(base, 'alpha');
  fs.mkdirSync(root);
  const guest = { id: 'friend', roots: [root] };
  const r = makeDir({
    config: { allowSend: true }, principal: guest, path: path.join(root, 'newproj'),
  });
  assert.equal(r.status, 201);
  assert.equal(fs.existsSync(path.join(root, 'newproj')), true);
});

test('目录授权校验实际父目录，允许在工作区内的别名下面递归新建', () => {
  const base = fixture();
  const root = path.join(base, 'alpha');
  const inside = path.join(root, 'project');
  fs.mkdirSync(inside);
  const outside = path.join(base, 'beta');
  const principal = { id: 'friend', roots: [root] };
  const config = { allowSend: true };
  const link = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(inside, path.join(root, 'inside'), link);
  fs.symlinkSync(outside, path.join(root, 'outside'), link);
  const denied = path.join(root, 'outside');
  assert.equal(browseDirs({ repo: emptyRepo, principal, path: denied }).status, 403);
  assert.equal(makeDir({ config, principal, path: path.join(denied, 'new', 'child') }).status, 403);
  assert.equal(fs.existsSync(path.join(outside, 'new')), false);
  assert.equal(makeDir({ config, principal, path: path.join(root, 'inside', 'new', 'child') }).status, 201);
  assert.equal(fs.statSync(path.join(inside, 'new', 'child')).isDirectory(), true);
});

test('访客创建目录时区分普通缺失后缀与悬空的父链接', () => {
  const root = tmpDir();
  const principal = { id: 'friend', roots: [root] };
  const config = { allowSend: true };
  const missing = path.join(root, 'unused');
  const broken = path.join(root, 'broken');
  fs.symlinkSync(missing, broken, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(makeDir({ config, principal, path: path.join(broken, 'child') }).status, 403);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(browseDirs({ repo: emptyRepo, principal, path: missing }).status, 404);
  assert.equal(makeDir({ config, principal, path: path.join(missing, 'child') }).status, 201);
});
