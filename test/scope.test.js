import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  normPath, under, inScope, scopeRepo,
} from '../src/scope.js';

// 用当前平台的绝对路径根拼测试路径：win32 得 'C:\\'，posix 得 '/'。
// 这样这组测试在两个平台上都有意义，只有明确针对 win32 语义的那一条跳过。
const ROOT = path.parse(process.cwd()).root;
const p = (...segs) => path.join(ROOT, ...segs);

test('under：自身与子目录为真', () => {
  assert.equal(under(p('ws', 'friend'), p('ws', 'friend')), true);
  assert.equal(under(p('ws', 'friend', 'proj', 'src'), p('ws', 'friend')), true);
});

test('under：同前缀的兄弟目录为假', () => {
  // 不按分隔符对齐的话 ws/friend-other 会被判进 ws/friend
  assert.equal(under(p('ws', 'friend-other'), p('ws', 'friend')), false);
  assert.equal(under(p('ws', 'friendx'), p('ws', 'friend')), false);
});

test('under：尾部分隔符不影响判定', () => {
  assert.equal(under(p('ws', 'friend') + path.sep, p('ws', 'friend')), true);
  assert.equal(under(p('ws', 'friend'), p('ws', 'friend') + path.sep), true);
});

test('under：父目录不在子目录之下', () => {
  assert.equal(under(p('ws'), p('ws', 'friend')), false);
});

test('normPath：win32 折叠大小写', { skip: process.platform !== 'win32' }, () => {
  // Windows 盘符与路径大小写不敏感
  assert.equal(normPath('c:\\workspace'), normPath('C:\\WORKSPACE'));
  assert.equal(under('c:\\ws\\friend\\proj', 'C:\\WS\\Friend'), true);
});

test('normPath：保留文件系统根目录本身（不剥成空串或裸盘符）', () => {
  const expected = process.platform === 'win32' ? ROOT.toLowerCase() : ROOT;
  assert.equal(normPath(ROOT), expected);
  assert.equal(under(p('a'), ROOT), true);
  assert.equal(under(ROOT, ROOT), true);
});

test('inScope：roots 为 null 恒真', () => {
  assert.equal(inScope(p('anywhere', 'at', 'all'), null), true);
  assert.equal(inScope(null, null), true);
});

test('inScope：cwd 缺失时默认拒绝', () => {
  // 读不到 cwd 就无法判断归属。宁可漏显示，不可漏出去。
  assert.equal(inScope(null, [p('ws', 'friend')]), false);
  assert.equal(inScope('', [p('ws', 'friend')]), false);
  assert.equal(inScope(undefined, [p('ws', 'friend')]), false);
});

// ── scopeRepo ──────────────────────────────────

const MINE = { key: 'claude:mine', cwd: p('ws', 'friend', 'proj'), mtimeMs: 100 };
const YOURS = { key: 'claude:yours', cwd: p('workspace', 'baton'), mtimeMs: 300 };
const OTHER = { key: 'claude:other', cwd: p('workspace', 'example'), mtimeMs: 200 };
const NOCWD = { key: 'claude:nocwd', cwd: null, mtimeMs: 400 };

function fakeRepo() {
  const chains = [
    { chainKey: 'k1', agent: 'claude', lastActivityMs: 300, members: [MINE, YOURS] },
    { chainKey: 'k2', agent: 'claude', lastActivityMs: 400, members: [OTHER, NOCWD] },
  ];
  const all = [MINE, YOURS, OTHER, NOCWD];
  return {
    listChains: () => chains.map((c) => ({ ...c, members: [...c.members] })),
    getSession: (key) => all.find((m) => m.key === key) ?? null,
    stats: () => ({ headReads: 7 }),
  };
}

const GUEST = { id: 'friend', roots: [p('ws', 'friend')] };
const OWNER_P = { id: 'owner', roots: null };

test('scopeRepo：owner 拿到的就是同一个对象，零包装', () => {
  const repo = fakeRepo();
  assert.equal(scopeRepo(repo, OWNER_P), repo);
});

test('scopeRepo：guest 只看到自己 roots 之下的成员', () => {
  const s = scopeRepo(fakeRepo(), GUEST);
  const chains = s.listChains();
  assert.equal(chains.length, 1, '成员全被滤掉的链整条丢弃');
  assert.equal(chains[0].chainKey, 'k1');
  assert.deepEqual(chains[0].members.map((m) => m.key), ['claude:mine']);
});

test('scopeRepo：lastActivityMs 按剩下的成员重算', () => {
  const s = scopeRepo(fakeRepo(), GUEST);
  // 原链的 300 来自被滤掉的 YOURS，不重算的话会泄露「有别的活动」这个事实
  assert.equal(s.listChains()[0].lastActivityMs, 100);
});

test('scopeRepo：getSession 对越界 key 返回 null', () => {
  const s = scopeRepo(fakeRepo(), GUEST);
  assert.equal(s.getSession('claude:mine').key, 'claude:mine');
  assert.equal(s.getSession('claude:yours'), null);
  assert.equal(s.getSession('claude:nocwd'), null, 'cwd 缺失对 guest 不可见');
});

test('scopeRepo：stats 透传', () => {
  assert.equal(scopeRepo(fakeRepo(), GUEST).stats().headReads, 7);
});
