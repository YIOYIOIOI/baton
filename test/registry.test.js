import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  pickRegistryDir, loadTemplate, buildRegistryEntry, writeRegistryEntry, retitleRegistryEntry,
} from '../src/agent/registry.js';
import { tmpDir } from './helpers.js';

function seed(root, sub, entries) {
  const d = path.join(root, 'acct', sub);
  fs.mkdirSync(d, { recursive: true });
  for (const e of entries) fs.writeFileSync(path.join(d, `local_${e.cliSessionId}.json`), JSON.stringify(e));
  return d;
}

const tpl = (id, over = {}) => ({
  sessionId: `local_${id}`, cliSessionId: id, cwd: 'C:\\old', originCwd: 'C:\\old',
  title: '模板标题', titleSource: 'auto', isArchived: false,
  createdAt: 1, lastActivityAt: 2, lastFocusedAt: 3,
  model: 'claude-opus-5', effort: 'max', permissionMode: 'bypassPermissions',
  cliBinaryPin: 'pinned-value', settingsKey: 'sk', enabledMcpTools: { 'x:y': false },
  forkedFromSessionId: 'parent-xxx', forkedAtMessageUuid: 'msg-yyy', ...over,
});

test('pickRegistryDir 跳过 backup 目录', () => {
  const root = tmpDir();
  seed(root, 'live', [tpl('a1'), tpl('a2')]);
  seed(root, 'live.backup-20260818', [tpl('a1'), tpl('a2'), tpl('a3')]);
  const picked = pickRegistryDir({ root });
  assert.ok(picked.dir.endsWith('live'), 'backup 目录条目更多也不能选它');
  assert.equal(picked.files.length, 2);
});

test('pickRegistryDir 在无候选时返回 null', () => {
  assert.equal(pickRegistryDir({ root: tmpDir() }), null);
});

test('loadTemplate 优先挑未归档的条目', () => {
  const root = tmpDir();
  seed(root, 'live', [tpl('a1', { isArchived: true }), tpl('a2', { isArchived: false, title: '活的' })]);
  const t = loadTemplate(pickRegistryDir({ root }));
  assert.equal(t.title, '活的');
});

test('buildRegistryEntry 改写关键字段并删掉分叉标记', () => {
  const e = buildRegistryEntry({
    template: tpl('old'), cliSessionId: 'bbbbbbbb-0000-4000-8000-000000000009',
    cwd: 'C:\\workspace\\baton', title: '手机上新建的会话', now: 1789000000000,
  });
  assert.equal(e.sessionId, 'local_bbbbbbbb-0000-4000-8000-000000000009');
  assert.equal(e.cliSessionId, 'bbbbbbbb-0000-4000-8000-000000000009');
  assert.equal(e.cwd, 'C:\\workspace\\baton');
  assert.equal(e.originCwd, 'C:\\workspace\\baton');
  assert.equal(e.title, '手机上新建的会话');
  assert.equal(e.titleSource, 'auto');
  assert.equal(e.isArchived, false);
  assert.equal(e.createdAt, 1789000000000);
  assert.equal(e.lastActivityAt, 1789000000000);
  assert.equal(e.lastFocusedAt, 1789000000000);
  assert.equal(e.forkedFromSessionId, undefined, '新建的会话不是分叉');
  assert.equal(e.forkedAtMessageUuid, undefined);
  assert.equal(e.cliBinaryPin, 'pinned-value', '语义不明的字段照抄模板');
  assert.equal(e.settingsKey, 'sk');
  assert.deepEqual(e.enabledMcpTools, { 'x:y': false });
});

test('writeRegistryEntry 原子写出 local_<id>.json', () => {
  const root = tmpDir();
  const dir = seed(root, 'live', [tpl('a1')]);
  const e = buildRegistryEntry({
    template: tpl('a1'), cliSessionId: 'cccccccc-0000-4000-8000-000000000001',
    cwd: 'C:\\p', title: 'T', now: 1,
  });
  const file = writeRegistryEntry(e, { dir });
  assert.ok(file.endsWith('local_cccccccc-0000-4000-8000-000000000001.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), e);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, '临时文件必须清干净');
});

test('非法 cliSessionId 拒绝写入', () => {
  assert.throws(
    () => buildRegistryEntry({ template: tpl('a1'), cliSessionId: '../evil', cwd: 'C:\\p', title: 'T', now: 1 }),
    /uuid/i,
  );
});

test('模板缺失时仍能产出可用条目', () => {
  const e = buildRegistryEntry({
    template: null, cliSessionId: 'dddddddd-0000-4000-8000-000000000002',
    cwd: 'C:\\p', title: 'T', now: 7,
  });
  assert.equal(e.sessionId, 'local_dddddddd-0000-4000-8000-000000000002');
  assert.equal(e.isArchived, false);
});

// ── 起好名字之后回来改标题（2026-10-08）───────────────────────────
//
// 起名是并着第一轮跑的（agent/title.js），回来时注册项早写完了。

test('retitleRegistryEntry 改标题，其余字段原样留着', () => {
  const root = tmpDir();
  const dir = seed(root, 'live', [tpl('a1')]);
  const e = buildRegistryEntry({
    template: tpl('a1'), cliSessionId: 'cccccccc-0000-4000-8000-000000000011',
    cwd: 'C:\\p', title: '修一下手机上发消息之后那个转圈一直不停的问题，我这边点了发送', now: 7,
  });
  const file = writeRegistryEntry(e, { dir });

  assert.equal(retitleRegistryEntry(file, '修发送转圈不停'), true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.title, '修发送转圈不停');
  assert.equal(after.titleSource, 'auto');
  assert.equal(after.cwd, 'C:\\p', '别的字段一个都不许动');
  assert.equal(after.createdAt, 7);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('retitleRegistryEntry 读回来再改，不拿内存里那份覆盖 App 的改动', () => {
  const root = tmpDir();
  const dir = seed(root, 'live', [tpl('a1')]);
  const file = writeRegistryEntry(buildRegistryEntry({
    template: tpl('a1'), cliSessionId: 'cccccccc-0000-4000-8000-000000000012', cwd: 'C:\\p', title: '首句', now: 1,
  }), { dir });
  // App 在这中间动过它：加了字段、改了活动时间
  const mid = JSON.parse(fs.readFileSync(file, 'utf8'));
  mid.completedTurns = 3;
  mid.lastActivityAt = 999;
  fs.writeFileSync(file, JSON.stringify(mid));

  retitleRegistryEntry(file, '起好的名字');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.title, '起好的名字');
  assert.equal(after.completedTurns, 3, 'App 写的字段不能被抹掉');
  assert.equal(after.lastActivityAt, 999);
});

test('人自己改过名字就不动它', () => {
  const root = tmpDir();
  const dir = seed(root, 'live', [tpl('a1')]);
  const file = writeRegistryEntry(buildRegistryEntry({
    template: tpl('a1'), cliSessionId: 'cccccccc-0000-4000-8000-000000000013', cwd: 'C:\\p', title: '首句', now: 1,
  }), { dir });
  for (const source of ['user', 'tool']) {
    const e = JSON.parse(fs.readFileSync(file, 'utf8'));
    e.title = '我自己取的';
    e.titleSource = source;
    fs.writeFileSync(file, JSON.stringify(e));
    assert.equal(retitleRegistryEntry(file, '起好的名字'), false, source);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, '我自己取的');
  }
});

test('注册项没了、标题是空的、标题没变——都当没这回事，不抛', () => {
  const root = tmpDir();
  const dir = seed(root, 'live', [tpl('a1')]);
  const file = writeRegistryEntry(buildRegistryEntry({
    template: tpl('a1'), cliSessionId: 'cccccccc-0000-4000-8000-000000000014', cwd: 'C:\\p', title: '一样的', now: 1,
  }), { dir });
  assert.equal(retitleRegistryEntry(path.join(dir, 'local_没有这个.json'), 'x'), false);
  assert.equal(retitleRegistryEntry(file, '   '), false);
  assert.equal(retitleRegistryEntry(file, '一样的'), false);
});
