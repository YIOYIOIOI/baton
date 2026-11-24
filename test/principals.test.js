import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createAuth } from '../src/http/auth.js';
import { loadPrincipals, ensureRoots, OWNER_ID } from '../src/principals.js';
import { scopeRepo } from '../src/scope.js';
import { tmpDir } from './helpers.js';

const workspace = tmpDir();
const p = (...segs) => path.join(workspace, ...segs);
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

test('无效的配置会暂停原身份，修好同一授权后设备可继续使用', () => {
  const valid = { guests: [{ id: 'friend', allowSend: true }] };
  const dir = withFile(valid);
  const file = path.join(dir, 'principals.json');
  const boot = () => createAuth({ token: 'q'.repeat(64),
    principals: loadPrincipals({ dir, workspacesRoot: WS, manageGenerations: true }).principals });
  const original = boot();
  const { bearer } = original.verifyPair(original.newPairingCode('friend'));
  const req = { headers: { authorization: 'Bearer ' + bearer } };
  for (const invalid of ['{', '{"guests":null}', '{"guests":[{"id":"friend","allowSend":"yes"}]}']) {
    fs.writeFileSync(file, invalid);
    assert.deepEqual(boot().principalIds(), [OWNER_ID]);
    assert.equal(original.authorize(req).ok, false);
    fs.writeFileSync(file, JSON.stringify(valid));
    assert.equal(boot().authorize(req).ok, true);
  }
  fs.writeFileSync(file, '{"guests":[]}');
  boot();
  fs.writeFileSync(file, JSON.stringify(valid));
  assert.equal(boot().authorize(req).ok, false);
});

test('自定义 root 原样采用', () => {
  const custom = p('elsewhere', 'laowang');
  const dir = withFile({ guests: [{ id: 'laowang', root: custom, allowSend: false }] });
  const g = loadPrincipals({ dir, workspacesRoot: WS }).principals.find((x) => x.id === 'laowang');
  assert.deepEqual(g.roots, [custom]);
  assert.equal(g.allowSend, false);
});

test('访客配置格式或权限类型有误时说明位置并拒绝该授权', () => {
  for (const bad of [[], { guests: {} }, { people: [] }, null]) {
    const r = loadPrincipals({ dir: withFile(bad), workspacesRoot: WS });
    assert.deepEqual(r.principals, [r.principals[0]]);
    assert.match(r.errors.join(' '), /guests/);
  }
  for (const fields of [{ roots: [WS] }, { allowSend: 'false' }, { allowSend: null }, { name: 42 }, { credentialVersion: {} }]) {
    const r = loadPrincipals({ dir: withFile({ guests: [{ id: 'bad', ...fields }, { id: 'good' }] }), workspacesRoot: WS });
    assert.deepEqual(r.principals.map((p) => p.id), ['owner', 'good']);
    assert.match(r.errors.join(' '), /bad/);
  }
});

test('守护进程保留升级时的合法访客，删除重建、换人或显式轮换会同时作废两种旧凭据', () => {
  const dir = tmpDir();
  const root = tmpDir();
  const token = 'g'.repeat(64);
  const guest = { id: 'friend', root, name: 'First' };
  const configure = (guests) => fs.writeFileSync(path.join(dir, 'principals.json'), JSON.stringify({ guests }));
  const authFor = (opts = {}) => createAuth({ token, principals: loadPrincipals({ dir, workspacesRoot: root, ...opts }).principals });
  const boot = () => authFor({ manageGenerations: true });
  const pair = (a) => a.verifyPair(a.newPairingCode('friend')).bearer;
  const allowed = (a, value) => a.authorize({ headers: { authorization: `Bearer ${value}` } }).ok;
  configure([guest]);
  const preUpgrade = pair(authFor());
  const shared = createHmac('sha256', token).update('baton-principal-v1:friend').digest('base64url');
  const migrated = boot();
  const newDevice = pair(migrated);
  const outstanding = migrated.newPairingCode('friend');
  for (const value of [preUpgrade, shared, newDevice]) assert.equal(allowed(boot(), value), true);
  configure([]);
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {loadPrincipals} from './src/principals.js'; const r = loadPrincipals({dir:process.env.BATON_DIR, manageGenerations:true}); if(r.errors.length) process.exitCode=1"],
  { env: { ...process.env, BATON_DIR: dir, CODEX_HOME: path.join(dir, 'synthetic-codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'synthetic-claude') } });
  assert.equal(allowed(migrated, preUpgrade), false, '先前已启动的守护进程也会读到另一个进程的吊销');
  assert.equal(migrated.verifyPair(outstanding).ok, false);
  assert.equal(migrated.principalOf('friend'), null);
  assert.equal(allowed(boot(), preUpgrade), false);
  configure([guest]);
  const replacement = boot();
  for (const value of [preUpgrade, shared, newDevice]) assert.equal(allowed(replacement, value), false);
  const second = pair(replacement);
  configure([{ ...guest, allowSend: false }]);
  assert.equal(allowed(boot(), second), true, '同一人的只读权限调整保持登录');
  assert.equal(allowed(replacement, second), false, '配置更新后仍采用旧写权限的进程必须停止授权');
  configure([{ ...guest, name: 'Second' }]);
  const reassigned = boot();
  assert.equal(allowed(reassigned, second), false);
  const third = pair(reassigned);
  configure([{ ...guest, name: 'Second', credentialVersion: 2 }]);
  assert.equal(allowed(boot(), third), false);
  assert.equal(allowed(boot(), token), true);
  const ledger = path.join(dir, 'principal-generations.sqlite');
  fs.renameSync(ledger, ledger + '.backup');
  assert.deepEqual(boot().principalIds(), ['owner'], '丢失已初始化的账本不能重新启用旧凭据');
  fs.copyFileSync(ledger + '.backup', ledger);
  assert.deepEqual(boot().principalIds(), ['owner', 'friend']);
});

test('两个面向管理员的配置示例都能作为有效访客配置载入', () => {
  for (const name of ['installation', 'cli']) {
    const doc = fs.readFileSync(new URL('../docs/' + name + '.md', import.meta.url), 'utf8');
    const sample = [...doc.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => JSON.parse(m[1])).find((s) => s.guests);
    assert.ok(sample?.guests?.length);
    assert.equal(path.isAbsolute(sample.guests[0].root), true);
    sample.guests[0].root = tmpDir();
    const { principals, errors } = loadPrincipals({ dir: withFile(sample), workspacesRoot: tmpDir() });
    assert.deepEqual(errors, []);
    assert.equal(principals[1].id, sample.guests[0].id);
  }
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

test('访客根目录按实际位置排除重叠，已授权目录的别名改指后不能扩大范围', () => {
  const base = tmpDir();
  const root = path.join(base, 'workspace');
  const child = path.join(root, 'project');
  fs.mkdirSync(child, { recursive: true });
  const alias = path.join(base, 'configured');
  const link = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(root, alias, link);
  const dir = withFile({ guests: [{ id: 'first', root: alias }, { id: 'second', root: child }] });
  const { principals } = loadPrincipals({ dir, workspacesRoot: base });
  assert.deepEqual(principals.map((p) => p.id), [OWNER_ID, 'first']);
  const member = { key: 'session', cwd: path.join(alias, 'project'), mtimeMs: 1 };
  const repo = scopeRepo({ getSession: () => member, listChains: () => [{ members: [member] }] }, principals[1]);
  assert.equal(repo.getSession('session').cwd, fs.realpathSync(child));
  fs.unlinkSync(alias);
  fs.symlinkSync(tmpDir(), alias, link);
  assert.equal(repo.getSession('session'), null);
  assert.deepEqual(repo.listChains(), []);
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

test('配置加载后上级目录改指时，启动初始化也不在新目标创建工作区', () => {
  const base = tmpDir();
  const alias = path.join(base, 'projects');
  const original = tmpDir();
  const replacement = tmpDir();
  const link = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(original, alias, link);
  const dir = withFile({ guests: [{ id: 'reader', root: path.join(alias, 'workspace') }] });
  const { principals } = loadPrincipals({ dir, workspacesRoot: base });
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, link);
  const [result] = ensureRoots(principals);
  assert.ok(result.error);
  assert.equal(fs.existsSync(path.join(replacement, 'workspace')), false);
});
