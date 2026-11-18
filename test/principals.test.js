import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPrincipals, ensureRoots, OWNER_ID } from '../src/principals.js';
import { tmpDir } from './helpers.js';

const ROOT = path.parse(process.cwd()).root;
const p = (...segs) => path.join(ROOT, ...segs);
const WS = p('BatonWorkspaces');

function withFile(json) {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'principals.json'), JSON.stringify(json));
  return dir;
}

test('文件不存在：只有 owner，无错误', () => {
  const r = loadPrincipals({ dir: tmpDir(), workspacesRoot: WS });
  assert.deepEqual(r.principals.map((x) => x.id), [OWNER_ID]);
  assert.equal(r.principals[0].roots, null);
  assert.deepEqual(r.errors, []);
});

test('坏 JSON：只有 owner，但要报出来，不静默', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'principals.json'), '{ 这不是 json');
  const r = loadPrincipals({ dir, workspacesRoot: WS });
  assert.deepEqual(r.principals.map((x) => x.id), [OWNER_ID]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /principals\.json/);
});

test('省略 root 时取 <workspacesRoot>/<id>', () => {
  const dir = withFile({ guests: [{ id: 'friend', name: 'Alice' }] });
  const r = loadPrincipals({ dir, workspacesRoot: WS });
  const g = r.principals.find((x) => x.id === 'friend');
  assert.deepEqual(g.roots, [path.join(WS, 'friend')]);
  assert.equal(g.name, 'Alice');
  assert.equal(g.allowSend, null, '不填 allowSend 时为 null，表示继承全局');
});

test('自定义 root 原样采用', () => {
  const custom = p('elsewhere', 'laowang');
  const dir = withFile({ guests: [{ id: 'laowang', root: custom, allowSend: false }] });
  const g = loadPrincipals({ dir, workspacesRoot: WS }).principals.find((x) => x.id === 'laowang');
  assert.deepEqual(g.roots, [custom]);
  assert.equal(g.allowSend, false);
});

test('id 为保留字 owner：拒绝并说明', () => {
  const dir = withFile({ guests: [{ id: 'owner' }] });
  const r = loadPrincipals({ dir, workspacesRoot: WS });
  assert.deepEqual(r.principals.map((x) => x.id), [OWNER_ID]);
  assert.match(r.errors[0], /owner.*保留字/);
});

test('id 非法：拒绝并说明规则', () => {
  const dir = withFile({ guests: [{ id: 'Friend!' }] });
  const r = loadPrincipals({ dir, workspacesRoot: WS });
  assert.equal(r.principals.length, 1);
  assert.match(r.errors[0], /id/);
});

test('id 重复：只留第一条', () => {
  const dir = withFile({ guests: [{ id: 'friend' }, { id: 'friend', root: p('x') }] });
  const r = loadPrincipals({ dir, workspacesRoot: WS });
  assert.deepEqual(r.principals.map((x) => x.id), [OWNER_ID, 'friend']);
  assert.match(r.errors[0], /重复/);
});

test('root 非绝对路径：拒绝', () => {
  const dir = withFile({ guests: [{ id: 'friend', root: 'relative/path' }] });
  const r = loadPrincipals({ dir, workspacesRoot: WS });
  assert.equal(r.principals.length, 1);
  assert.match(r.errors[0], /绝对路径/);
});

test('自定义 root 嵌套进另一个 guest 的默认 root：拒绝', () => {
  // 这条是嵌套检查必须发生在「root 解析之后」的理由：
  // id 唯一时默认 root 之间不可能嵌套，只有自定义 root 会撞进默认 root 里
  const dir = withFile({
    guests: [
      { id: 'friend' }, //                                       → <WS>/friend
      { id: 'laowang', root: path.join(WS, 'friend', 'sub') }, // 落在 friend 之下
    ],
  });
  const r = loadPrincipals({ dir, workspacesRoot: WS });
  assert.deepEqual(r.principals.map((x) => x.id), [OWNER_ID, 'friend']);
  assert.match(r.errors[0], /嵌套/);
});

test('ensureRoots：不存在就建，已存在就不动', () => {
  const base = tmpDir();
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  fs.mkdirSync(b);
  const out = ensureRoots([
    { id: 'owner', roots: null },
    { id: 'ga', roots: [a] },
    { id: 'gb', roots: [b] },
  ]);
  assert.deepEqual(out.map((x) => [x.id, x.created]), [['ga', true], ['gb', false]]);
  assert.equal(fs.existsSync(a), true);
});

test('ensureRoots：建不出来时记下原因，不抛', () => {
  // 建不出来不能拖垮启动——横幅里报出来，owner 自己去看那个路径怎么了
  const out = ensureRoots([{ id: 'bad', roots: [p('ws', 'x')] }], {
    exists: () => false,
    mkdir: () => { throw new Error('EPERM'); },
  });
  assert.equal(out[0].created, false);
  assert.match(out[0].error, /EPERM/);
});
