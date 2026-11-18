import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRepo } from '../src/repo.js';
import { tmpDir, writeJsonl } from './helpers.js';

function fixture() {
  const claudeRoot = tmpDir();
  const codexRoot = tmpDir();
  const registryRoot = tmpDir();
  const stateDir = tmpDir();

  const OWN = 'aaaaaaaa-0000-0000-0000-000000000001';
  const CHILD = 'cccccccc-0000-0000-0000-000000000003';

  writeJsonl(claudeRoot, path.join('C--proj', `${OWN}.jsonl`), [
    { type: 'user', sessionId: OWN, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '原始会话第一句' } },
    { type: 'custom-title', customTitle: '原始标题', sessionId: OWN },
  ]);
  writeJsonl(claudeRoot, path.join('C--proj', `${CHILD}.jsonl`), [
    { type: 'user', sessionId: OWN, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '原始会话第一句' } },
    { type: 'user', sessionId: CHILD, uuid: 'u9', cwd: 'C:\\proj', timestamp: '2026-09-08T09:00:00Z',
      message: { role: 'user', content: '分叉后继续' } },
  ]);
  writeJsonl(codexRoot, path.join('2026', '09', '10',
    'rollout-2026-09-10T11-18-29-01a08952-f1de-7f62-8cf7-6d96d018aef8.jsonl'), [
    { ordinal: 0, type: 'session_meta', timestamp: '2026-09-10T03:18:29Z',
      payload: { cwd: 'C:\\example', cli_version: '0.153.4', context_window: 828400, thread_source: 'user' } },
    { ordinal: 1, type: 'response_item', timestamp: '2026-09-10T03:18:30Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context> x' }] } },
    { ordinal: 2, type: 'response_item', timestamp: '2026-09-10T03:18:31Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看一下当前工程' }] } },
  ]);

  const regDir = path.join(registryRoot, 'acct', 'org');
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, `local_${OWN}.json`), JSON.stringify({
    sessionId: `local_${OWN}`, cliSessionId: OWN, title: '注册表里的标题', titleSource: 'auto',
    isArchived: false, cwd: 'C:\\proj',
  }));

  const codexStateFile = path.join(stateDir, 'state.json');
  fs.writeFileSync(codexStateFile, JSON.stringify({ 'electron-persisted-atom-state': { 'thread-descriptions-v1': {} } }));

  return { claudeRoot, codexRoot, registryRoot, codexStateFile, OWN, CHILD };
}

test('listChains 把分叉与本体聚为一条链', () => {
  const f = fixture();
  const chains = createRepo(f).listChains();
  const claude = chains.filter((c) => c.agent === 'claude');
  assert.equal(claude.length, 1, '本体与分叉必须在同一条链');
  assert.equal(claude[0].members.length, 2);
  assert.equal(claude[0].chainKey, f.OWN);
});

test('标题取注册表那份，档位为 1', () => {
  const f = fixture();
  const chains = createRepo(f).listChains();
  const own = chains.flatMap((c) => c.members).find((m) => m.providerId === f.OWN);
  assert.equal(own.title, '注册表里的标题');
  assert.equal(own.titleTier, 1);
});

test('无注册项、也没有名字记录的分叉落第 2 档（首句）', () => {
  const f = fixture();
  const child = createRepo(f).listChains().flatMap((c) => c.members).find((m) => m.providerId === f.CHILD);
  assert.equal(child.titleTier, 2);
  assert.equal(child.title, '原始会话第一句', '分叉复制了历史，首句仍是原始那句');
});

test('Codex 会话跳过合成前言，档位为 2', () => {
  const f = fixture();
  const codex = createRepo(f).listChains().find((c) => c.agent === 'codex');
  assert.equal(codex.members[0].title, '看一下当前工程');
  assert.equal(codex.members[0].titleTier, 2);
  assert.equal(codex.members[0].cwd, 'C:\\example');
});

test('子 agent 运行不得出现在会话列表里', () => {
  const f = fixture();
  writeJsonl(f.codexRoot, path.join('2026', '09', '11',
    'rollout-2026-09-11T00-00-00-01a09999-aaaa-7f62-8cf7-6d96d018aef8.jsonl'), [
    { ordinal: 0, type: 'session_meta', timestamp: '2026-09-11T00:00:00Z',
      payload: { cwd: 'C:\\example', thread_source: 'subagent' } },
    { ordinal: 1, type: 'response_item', timestamp: '2026-09-11T00:00:01Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '子任务指令' }] } },
  ]);
  const ids = createRepo(f).listChains().flatMap((c) => c.members).map((m) => m.providerId);
  assert.ok(!ids.includes('01a09999-aaaa-7f62-8cf7-6d96d018aef8'), 'subagent 运行必须被过滤掉');
});

test('读不到 thread_source 时放行（宁可多显示一条，不可丢真会话）', () => {
  const f = fixture();
  writeJsonl(f.codexRoot, path.join('2026', '09', '12',
    'rollout-2026-09-12T00-00-00-01a09888-bbbb-7f62-8cf7-6d96d018aef8.jsonl'), [
    { ordinal: 0, type: 'response_item', timestamp: '2026-09-12T00:00:00Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '没有 session_meta 的会话' }] } },
  ]);
  const ids = createRepo(f).listChains().flatMap((c) => c.members).map((m) => m.providerId);
  assert.ok(ids.includes('01a09888-bbbb-7f62-8cf7-6d96d018aef8'));
});

test('getSession 按 key 取回，未知 key 返回 null', () => {
  const f = fixture();
  const repo = createRepo(f);
  const m = repo.listChains().flatMap((c) => c.members)[0];
  assert.equal(repo.getSession(m.key).providerId, m.providerId);
  assert.equal(repo.getSession('claude:bm9wZQ'), null);
});

test('重复调用命中缓存，不重复读头部', () => {
  const f = fixture();
  const repo = createRepo(f);
  repo.listChains();
  const before = repo.stats().headReads;
  repo.listChains();
  assert.equal(repo.stats().headReads, before, '第二次列表不得重读文件头');
});

// ── 按 key 取一个会话，不许每次全盘扫一遍（2026-10-01 审查）──────────────
//
// 实测 159 个会话、缓存全热时，每次 getSession 仍要 30 ms：列两棵树再 stat 每个文件
// 约 9 ms，把桌面注册表 85 个 JSON 全读一遍约 14 ms。全是同步读盘——这段时间整个
// 守护进程都卡着，而一屏缩略图就是十几次。

import { encodeKey } from '../src/providers.js';

test('getSession 不扫整棵树，也不每次重读整个注册表', () => {
  const f = fixture();
  const repo = createRepo(f);
  const keys = repo.listChains().flatMap((c) => c.members).map((m) => m.key);
  const before = repo.stats();
  for (let i = 0; i < 10; i += 1) for (const k of keys) repo.getSession(k);
  const after = repo.stats();
  assert.equal(after.scans - before.scans, 0, '按 key 取一个会话不该触发全盘扫描');
  assert.equal(after.registryReads - before.registryReads, 0, '刚读过的注册表在短时间内复用');
  // 对照：列表确实会扫、会读——不然上面两条是在比两个 undefined
  repo.listChains();
  assert.equal(repo.stats().scans - after.scans, 1);
  assert.equal(repo.stats().registryReads - after.registryReads, 1, '列表每次都读新的，标题要跟得上 App');
});

test('getSession 取回的和列表里的是同一份', () => {
  const f = fixture();
  const repo = createRepo(f);
  for (const m of repo.listChains().flatMap((c) => c.members)) {
    assert.deepEqual(repo.getSession(m.key), m, `${m.providerId} 两条路算出来要一模一样`);
  }
});

test('getSession 只认列表里会出现的那种文件', () => {
  const f = fixture();
  // 子 agent 追踪：<项目>/<会话>/subagents/*.jsonl，列表里没有它
  writeJsonl(f.claudeRoot, path.join('C--proj', f.OWN, 'subagents', 'agent-x.jsonl'), [
    { type: 'user', sessionId: 'x', cwd: 'C:\\proj', message: { role: 'user', content: '子 agent' } },
  ]);
  // codex 的子 agent 运行：文件名一样，只能读头部分辨
  const sub = path.join('2026', '09', '11', 'rollout-2026-09-11T00-00-00-01a09999-aaaa-7f62-8cf7-6d96d018aef8.jsonl');
  writeJsonl(f.codexRoot, sub, [
    { ordinal: 0, type: 'session_meta', timestamp: '2026-09-11T00:00:00Z', payload: { cwd: 'C:\\papers', thread_source: 'subagent' } },
  ]);
  const repo = createRepo(f);
  assert.equal(repo.getSession(encodeKey('claude', `C--proj/${f.OWN}/subagents/agent-x.jsonl`)), null);
  assert.equal(repo.getSession(encodeKey('codex', sub.split(path.sep).join('/'))), null);
  assert.equal(repo.getSession(encodeKey('claude', 'C--proj/不存在.jsonl')), null);
});

// ── 以 App 显示为主（2026-10-01 owner：「会话应该要以app显示为主」）────────────
//
// App 里一行 = 一条会话；它名下换过的旧 transcript、在 App 里删掉的会话，都不该在
// Baton 里多出一行。项目分组也跟 App：worktree 会话归原仓库，Codex 的独立聊天归一组。

const listed = (repo) => repo.listChains().flatMap((c) => c.members);
const regDirOf = (f) => path.join(f.registryRoot, 'acct', 'org');

test('App 里被接替的旧 transcript 不单列；按 key 打开仍能看，标题跟着那条会话', () => {
  const f = fixture();
  const OLD = 'dddddddd-0000-0000-0000-000000000004';
  const NEW = 'eeeeeeee-0000-0000-0000-000000000005';
  for (const [id, text] of [[OLD, '压缩前'], [NEW, '压缩后']]) {
    writeJsonl(f.claudeRoot, path.join('C--proj', `${id}.jsonl`), [
      { type: 'user', sessionId: id, uuid: `u-${id}`, cwd: 'C:\\proj', timestamp: '2026-09-20T00:00:00Z',
        message: { role: 'user', content: text } },
      { type: 'custom-title', customTitle: 'Example task (fork)', sessionId: id },
    ]);
  }
  fs.writeFileSync(path.join(regDirOf(f), 'local_app9.json'), JSON.stringify({
    sessionId: 'local_app9', cliSessionId: NEW, priorCliSessionIds: [OLD], title: 'Example task (fork)',
    isArchived: false, cwd: 'C:\\proj', originCwd: 'C:\\proj',
  }));
  const repo = createRepo(f);
  const ids = listed(repo).map((m) => m.providerId);
  assert.ok(ids.includes(NEW));
  assert.ok(!ids.includes(OLD), 'App 侧栏里没有这一行，Baton 也不该有');

  const old = repo.getSession(encodeKey('claude', `C--proj/${OLD}.jsonl`));
  assert.ok(old, '手里有它的 key（比如手机正开着）时还能打开');
  assert.equal(old.title, 'Example task (fork)');
  assert.equal(old.titleTier, 1);
});

test('在 App 里删掉的会话不列出', () => {
  const f = fixture();
  const GONE = 'ffffffff-0000-0000-0000-000000000006';
  writeJsonl(f.claudeRoot, path.join('C--proj', `${GONE}.jsonl`), [
    { type: 'user', sessionId: GONE, uuid: 'g1', cwd: 'C:\\proj', timestamp: '2026-09-28T00:00:00Z',
      message: { role: 'user', content: 'Demo site' } },
  ]);
  fs.writeFileSync(path.join(regDirOf(f), `deleted_${GONE}`), '1790800177013');
  // 墓碑只认它自己那个 id：注册表里活着的不受影响
  fs.writeFileSync(path.join(regDirOf(f), `deleted_${f.OWN}`), '1787277656878');
  const ids = listed(createRepo(f)).map((m) => m.providerId);
  assert.ok(!ids.includes(GONE));
  assert.ok(ids.includes(f.OWN), '注册表里活着就以注册表为准');
});

/*
  2026-10-01 实测两例：同一个 id 在两个项目目录各一份（会话中途进了 worktree /
  换了目录，CLI 在新目录下也写了一份）。两份首条记录相同，一份停在 9 月 15 日，
  另一份一直写到现在——App 只有一行，接着写的是新的那份。
*/
test('同一个 id 在两个项目目录各有一份时，只列还在写的那份', () => {
  const f = fixture();
  const stale = writeJsonl(f.claudeRoot, path.join('C--proj--claude-worktrees-webui', `${f.OWN}.jsonl`), [
    { type: 'user', sessionId: f.OWN, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '原始会话第一句' } },
  ]);
  const old = new Date('2026-09-15T00:00:00Z');
  fs.utimesSync(stale, old, old);
  const own = listed(createRepo(f)).filter((m) => m.providerId === f.OWN);
  assert.equal(own.length, 1);
  assert.ok(own[0].file.includes(`C--proj${path.sep}`), '留下的是还在写的那份');
});

test('worktree 会话的项目是原仓库，不是 worktree 那个随机名字', () => {
  const f = fixture();
  const W = '99999999-0000-0000-0000-000000000009';
  const wt = 'C:\\site\\.claude\\worktrees\\wt-alpha';
  writeJsonl(f.claudeRoot, path.join('C--site--claude-worktrees-wt-alpha', `${W}.jsonl`), [
    { type: 'user', sessionId: W, uuid: 'w1', cwd: wt, timestamp: '2026-09-29T00:00:00Z',
      message: { role: 'user', content: '把网站适配手机' } },
  ]);
  fs.writeFileSync(path.join(regDirOf(f), `local_${W}.json`), JSON.stringify({
    sessionId: `local_${W}`, cliSessionId: W, title: '网站移动端适配', isArchived: false,
    cwd: wt, originCwd: 'C:\\site', worktreeName: 'wt-alpha',
  }));
  const m = listed(createRepo(f)).find((x) => x.providerId === W);
  assert.equal(m.title, '网站移动端适配');
  assert.equal(m.project.name, 'site');
  assert.equal(m.cwd, wt, 'cwd 不动：上传、看文件、发消息都还是在 worktree 里');
});

test('Codex 标题取线程名索引；独立聊天归到一组', () => {
  const f = fixture();
  const ID = '01a08952-f1de-7f62-8cf7-6d96d018aef8';
  fs.writeFileSync(path.join(path.dirname(f.codexStateFile), 'session_index.jsonl'),
    `${JSON.stringify({ id: ID, thread_name: 'Sample Codex Task', updated_at: '2026-09-10T03:20:00Z' })}\n`);
  const CHAT = '01a0c349-8443-74a2-bb63-38f7d7d564f3';
  writeJsonl(f.codexRoot, path.join('2026', '09', '21', `rollout-2026-09-21T10-00-00-${CHAT}.jsonl`), [
    { ordinal: 0, type: 'session_meta', timestamp: '2026-09-21T02:00:00Z',
      payload: { cwd: 'C:\\Users\\u\\Documents\\Codex\\2026-09-21\\chat-1', thread_source: 'user' } },
    { ordinal: 1, type: 'response_item', timestamp: '2026-09-21T02:00:01Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Generate a sample token' }] } },
  ]);
  fs.writeFileSync(f.codexStateFile, JSON.stringify({ 'projectless-thread-ids': [CHAT] }));

  const ms = listed(createRepo(f));
  const named = ms.find((m) => m.providerId === ID);
  assert.deepEqual([named.title, named.titleTier], ['Sample Codex Task', 1]);
  assert.equal(named.project.name, 'example');
  assert.equal(ms.find((m) => m.providerId === CHAT).project.name, 'Codex 独立聊天');
});
