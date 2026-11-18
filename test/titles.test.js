import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  claudeApp, claudeRegistry, codexApp, codexDescriptions, codexThreadNames, isCodexChat,
  resolveProject, resolveTitle,
} from '../src/titles.js';
import { tmpDir } from './helpers.js';

function reg(dir, sub, entries) {
  const d = path.join(dir, 'acct', sub);
  fs.mkdirSync(d, { recursive: true });
  for (const e of entries) {
    fs.writeFileSync(path.join(d, `local_${e.cliSessionId}.json`), JSON.stringify(e));
  }
}

test('claudeRegistry 跳过 backup 目录，不产生重复身份', () => {
  const root = tmpDir();
  reg(root, 'org', [
    { sessionId: 'local_1', cliSessionId: 'cdb72dd5', title: '活动目录里的标题', titleSource: 'auto', isArchived: false },
    { sessionId: 'local_2', cliSessionId: 'f91c66a2', title: '另一条', titleSource: 'auto', isArchived: true },
  ]);
  reg(root, 'org.backup-20260818', [
    { sessionId: 'local_1', cliSessionId: 'cdb72dd5', title: '备份里的旧标题', titleSource: 'auto', isArchived: false },
  ]);
  const m = claudeRegistry({ root });
  assert.equal(m.size, 2);
  assert.equal(m.get('cdb72dd5').title, '活动目录里的标题', 'backup 目录里的同 id 条目不得覆盖活动目录');
  assert.equal(m.get('f91c66a2').isArchived, true);
});

test('claudeRegistry 在多个候选目录中取索引文件最多的', () => {
  const root = tmpDir();
  reg(root, 'few', [{ sessionId: 'local_x', cliSessionId: 'x1', title: '少' }]);
  reg(root, 'many', [
    { sessionId: 'local_a', cliSessionId: 'a1', title: '多1' },
    { sessionId: 'local_b', cliSessionId: 'b1', title: '多2' },
  ]);
  const m = claudeRegistry({ root });
  assert.equal(m.size, 2);
  assert.ok(m.has('a1') && m.has('b1'));
});

test('claudeRegistry 目录不存在时返回空 Map 而不抛异常', () => {
  assert.equal(claudeRegistry({ root: path.join(tmpDir(), 'nope') }).size, 0);
});

test('codexDescriptions 从 electron-persisted-atom-state 取出标题表', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({
    'electron-persisted-atom-state': {
      'thread-descriptions-v1': { '01a04286': 'Reasoning effort notes' },
    },
  }));
  const m = codexDescriptions({ file: f });
  assert.equal(m.get('01a04286'), 'Reasoning effort notes');
});

test('codexDescriptions 文件缺失或结构变动时返回空 Map', () => {
  assert.equal(codexDescriptions({ file: path.join(tmpDir(), 'nope.json') }).size, 0);
  const dir = tmpDir();
  const f = path.join(dir, 'x.json');
  fs.writeFileSync(f, JSON.stringify({ 'electron-persisted-atom-state': {} }));
  assert.equal(codexDescriptions({ file: f }).size, 0);
});

test('Claude 第 1 档：注册表压过 transcript 的 custom-title', () => {
  const registry = new Map([['s1', { title: 'CPU占用最高的进程 (fork)' }]]);
  const r = resolveTitle({
    agent: 'claude', providerId: 's1', registry, descriptions: new Map(),
    customTitle: 'CPU占用最高的进程', firstUserText: '看看 CPU',
  });
  assert.equal(r.title, 'CPU占用最高的进程 (fork)', 'App 渲染的是注册表那份');
  assert.equal(r.titleTier, 1);
});

/*
  不在桌面 App 里的会话，采用 Claude CLI 的标题优先级：
    agentName || customTitle || aiTitle || summary || 首句 || …
*/
test('不在 App 里的 Claude 会话按 CLI 的顺序：agent-name > custom-title > ai-title > 首句', () => {
  const t = (over) => resolveTitle({
    agent: 'claude', providerId: 's1', registry: new Map(), descriptions: new Map(),
    agentName: null, customTitle: null, aiTitle: null, firstUserText: 'Initial review prompt for sample workspace', ...over,
  });
  assert.deepEqual(t({ agentName: 'reviewer-agent', customTitle: 'general-reviewer', aiTitle: 'review' }),
    { title: 'reviewer-agent', titleTier: 1 });
  assert.deepEqual(t({ customTitle: 'build script cleanup', aiTitle: 'cleanup' }),
    { title: 'build script cleanup', titleTier: 1 });
  assert.deepEqual(t({ aiTitle: 'architecture review' }),
    { title: 'architecture review', titleTier: 1 }, 'CLI 自己起的名字也是「CLI 里显示的那个」');

  const derived = t({ firstUserText: 'Please inspect the compiler warnings and fix the failing integration tests across all packages in the workspace' });
  assert.equal(derived.titleTier, 2, '只有首句可用时才算推导');
  assert.ok(derived.title.length <= 61, '推导出的标题要截断');
  assert.ok(derived.title.startsWith('Please inspect the compiler warnings'));
});

test('被接替的旧 transcript 用接替它的那条 App 会话的标题', () => {
  const lineage = new Map([['old1', { title: 'Example task (fork)' }]]);
  const r = resolveTitle({
    agent: 'claude', providerId: 'old1', registry: new Map(), lineage, descriptions: new Map(),
    customTitle: 'Example task (fork)', firstUserText: 'x',
  });
  assert.deepEqual(r, { title: 'Example task (fork)', titleTier: 1 });
});

/*
  Codex App 标题优先读 ~/.codex/session_index.jsonl（与 state_5.sqlite 的 threads.name 一致），
  thread-descriptions-v1 作为无线程名老版本的兜底。
*/
test('Codex：线程名 > 描述 > 首句', () => {
  const names = new Map([['01a0c79a', 'Feature exploration']]);
  const descriptions = new Map([['01a0c79a', '一段描述'], ['01a04286', 'Reasoning level notes']]);
  const t = (id, first = '看一下当前工程') => resolveTitle({
    agent: 'codex', providerId: id, registry: new Map(), names, descriptions, firstUserText: first,
  });
  assert.deepEqual(t('01a0c79a', '请优先考虑解析方法'), { title: 'Feature exploration', titleTier: 1 });
  assert.deepEqual(t('01a04286'), { title: 'Reasoning level notes', titleTier: 1 });
  assert.deepEqual(t('zzz'), { title: '看一下当前工程', titleTier: 2 });
});

test('全都没有时用 cwd 目录名加日期兜底，两边都是第 3 档', () => {
  for (const agent of ['codex', 'claude']) {
    const r = resolveTitle({
      agent, providerId: 'zzz', registry: new Map(), descriptions: new Map(),
      firstUserText: null, cwd: 'C:\\workspace\\example', firstTs: '2026-09-10T03:18:29Z',
    });
    assert.match(r.title, /example/);
    assert.match(r.title, /2026-09-10/);
    assert.equal(r.titleTier, 3);
  }
});

// ── 桌面 App 的会话账本 ─────────────────────────────────────────────

/** 往注册表的 <account>/<org> 目录里写文件：对象写成 JSON，字符串原样写（墓碑） */
function regFiles(root, files) {
  const d = path.join(root, 'acct', 'org');
  fs.mkdirSync(d, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return d;
}

/*
  App 里一条会话会换着写好几个 transcript：压缩上下文之后 CLI 换新 id 接着写，
  旧 id 记进 priorCliSessionIds。App 侧栏只有一行：
    活着的句柄  [cliSessionId, unarchivedCliSessionId]
    旧段        [preClearCliSessionId, ...priorCliSessionIds]
*/
test('claudeApp：旧段归到接替它的那条会话，不算单独的会话', () => {
  const root = tmpDir();
  regFiles(root, {
    'local_app1.json': {
      sessionId: 'local_app1', cliSessionId: 'new1', priorCliSessionIds: ['old1', 'old2'],
      preClearCliSessionId: 'old0', title: 'Example task (fork)', cwd: 'C:\\w', originCwd: 'C:\\w',
    },
    'local_app2.json': { sessionId: 'local_app2', cliSessionId: 'cur2', unarchivedCliSessionId: 'un2', title: '另一条' },
  });
  const app = claudeApp({ root });
  assert.deepEqual([...app.sessions.keys()].sort(), ['cur2', 'new1', 'un2']);
  for (const id of ['old0', 'old1', 'old2']) assert.equal(app.lineage.get(id)?.title, 'Example task (fork)', id);
  assert.equal(app.sessions.get('un2').title, '另一条', 'unarchivedCliSessionId 也是活着的句柄');
});

test('claudeApp：一个 id 既是 A 的旧段又是 B 的活句柄时，按活的算', () => {
  const root = tmpDir();
  regFiles(root, {
    'local_a.json': { sessionId: 'local_a', cliSessionId: 'x2', priorCliSessionIds: ['x1'], title: 'A' },
    'local_b.json': { sessionId: 'local_b', cliSessionId: 'x1', title: 'B' },
  });
  const app = claudeApp({ root });
  assert.equal(app.sessions.get('x1').title, 'B');
  assert.ok(!app.lineage.has('x1'));
});

/*
  在 App 里删会话：注册项删掉，同目录写 deleted_<id> 墓碑（内容是删除时刻的毫秒数），
  会话自己的 id 和它名下所有 transcript 的 id 各一个——transcript 文件本身留在盘上。
*/
test('claudeApp：deleted_<id> 墓碑 = 在 App 里删掉了；活着的句柄不受旧墓碑影响', () => {
  const root = tmpDir();
  regFiles(root, {
    'deleted_0000aaaa': '1790800177013',
    'deleted_0000bbbb': '1790800177013',
    'deleted_back1': '1787277656878',
    'local_r.json': { sessionId: 'local_r', cliSessionId: 'back1', title: '删了又回来的' },
  });
  const app = claudeApp({ root });
  assert.ok(app.deleted.has('0000aaaa'));
  assert.ok(app.deleted.has('0000bbbb'));
  assert.ok(!app.deleted.has('back1'), '注册表里活着就以注册表为准');
});

/*
  App 侧栏标题回退：
    title: n.title || n.spawnedFrom?.title || (n.title || n.worktreeName || "")
    cwd:   n.originCwd || n.cwd
  所以 worktree 会话归在**原仓库**底下，而不是 worktree 那个随机名字的目录。
*/
test('claudeApp：标题按 App 侧栏的写法回退，项目目录取 originCwd', () => {
  const root = tmpDir();
  regFiles(root, {
    'local_w.json': {
      sessionId: 'local_w', cliSessionId: 'w1', title: 'Responsive layout',
      cwd: 'C:\\workspace\\website\\.claude\\worktrees\\wt-alpha',
      originCwd: 'C:\\workspace\\website', worktreeName: 'wt-alpha',
    },
    'local_s.json': { sessionId: 'local_s', cliSessionId: 's1', title: '', spawnedFrom: { title: 'Follow-up fix' }, cwd: 'C:\\d' },
    'local_t.json': { sessionId: 'local_t', cliSessionId: 't1', title: '', worktreeName: 'wt-beta', cwd: 'C:\\d' },
  });
  const app = claudeApp({ root });
  assert.equal(app.sessions.get('w1').title, 'Responsive layout');
  assert.equal(app.sessions.get('w1').project, 'C:\\workspace\\website');
  assert.equal(app.sessions.get('s1').title, 'Follow-up fix');
  assert.equal(app.sessions.get('s1').project, 'C:\\d', '没有 originCwd 就用 cwd');
  assert.equal(app.sessions.get('t1').title, 'wt-beta', 'App 自己就是这么兜底的');
});

test('claudeApp：没有注册表目录时三样都是空的，不抛', () => {
  const app = claudeApp({ root: path.join(tmpDir(), 'nope') });
  assert.equal(app.sessions.size + app.lineage.size + app.deleted.size, 0);
});

// ── Codex 的线程名与独立聊天 ─────────────────────────────────────────

test('codexThreadNames：后写的覆盖先写的（改名），空名字等于没名字，坏行跳过', () => {
  const f = path.join(tmpDir(), 'session_index.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ id: 'a', thread_name: 'Old thread title', updated_at: '2026-07-28T03:43:27Z' }),
    '{坏行',
    JSON.stringify({ id: 'b', thread_name: 'Regex helper task', updated_at: '2026-07-29T07:18:43Z' }),
    JSON.stringify({ id: 'a', thread_name: 'Renamed thread', updated_at: '2026-07-29T07:38:32Z' }),
    JSON.stringify({ id: 'b', thread_name: '  ', updated_at: '2026-07-30T00:00:00Z' }),
    '',
  ].join('\n'));
  const m = codexThreadNames({ file: f });
  assert.equal(m.get('a'), 'Renamed thread', '改过名的取最后一次');
  assert.ok(!m.has('b'), '改成空名字就回到没名字');
  assert.equal(codexThreadNames({ file: path.join(tmpDir(), 'nope.jsonl') }).size, 0);
});

/*
  Codex App 里不归任何项目的线程叫「独立聊天」，工作目录是它自己在
  Documents\Codex\<日期>\<随机短名> 下建的。
*/
const TEST_ROOT = path.parse(process.cwd()).root;
const osPath = (...segs) => path.join(TEST_ROOT, ...segs);

test('codexApp：独立聊天 = projectless 名单 ∪ 落在它们工作区根下的', () => {
  const f = path.join(tmpDir(), 'state.json');
  const docsCodex = osPath('users', 'u', 'Documents', 'Codex');
  const docsCodexOther = osPath('users', 'u', 'Documents', 'Codex-other');
  const exProj = osPath('workspace', 'example');
  fs.writeFileSync(f, JSON.stringify({
    'projectless-thread-ids': ['t1', 't2'],
    'thread-workspace-root-hints': { t1: docsCodex, t9: exProj },
    'electron-persisted-atom-state': { 'thread-descriptions-v1': { t1: '描述' } },
  }));
  const { chats, descriptions } = codexApp({ file: f });
  assert.equal(descriptions.get('t1'), '描述');
  assert.ok(isCodexChat('t2', osPath('anywhere'), chats), '名单里的就是');
  assert.ok(isCodexChat('t3', path.join(docsCodex, '2026-08-28', 'chat-2'), chats), '名单漏了但目录在聊天根下的也是');
  assert.ok(!isCodexChat('t4', exProj, chats), '项目线程的 hint 不能当聊天根');
  assert.ok(!isCodexChat('t5', docsCodexOther, chats), '前缀相同不等于在里面');
});

test('resolveProject：Claude 跟注册表的项目目录，Codex 独立聊天归一组，其余按 cwd', () => {
  const siteDir = osPath('workspace', 'website');
  const wtDir = path.join(siteDir, '.claude', 'worktrees', 'wt-alpha');
  const batonDir = osPath('workspace', 'baton');
  const dailyDir = osPath('workspace', 'daily');
  const chatDir = osPath('users', 'u', 'Documents', 'Codex', '2026-09-21', 'chat-1');
  const exDir = osPath('workspace', 'example');

  const app = {
    sessions: new Map([['w1', { project: siteDir }]]),
    lineage: new Map([['old1', { project: batonDir }]]),
  };
  const chats = { ids: new Set(['c1']), roots: [] };
  const p = (agent, id, cwd) => resolveProject({ agent, providerId: id, cwd, app, chats });

  assert.equal(p('claude', 'w1', wtDir).name, 'website');
  assert.equal(p('claude', 'old1', batonDir).name, 'baton');
  assert.equal(p('claude', 'cli1', dailyDir + path.sep).name, 'daily', '不在 App 里就按 cwd');
  if (process.platform === 'win32') {
    assert.equal(p('claude', 'x', 'C:\\Proj').key, p('claude', 'y', 'c:\\proj\\').key, '大小写、末尾分隔符不影响归组');
  }
  assert.deepEqual(p('codex', 'c1', chatDir), { key: 'codex:chats', name: 'Codex 独立聊天' });
  assert.equal(p('codex', 'c2', exDir).name, 'example');
  assert.equal(p('claude', 'z', null), null, '没有目录就不编一个');
  // 组头上「在这里开新会话」用的目录：worktree 会话给的是项目根，原样大小写；独立聊天没有一个目录
  assert.equal(p('claude', 'w1', wtDir).dir, path.resolve(siteDir));
  assert.equal(p('claude', 'cli1', dailyDir + path.sep).dir, path.resolve(dailyDir));
  assert.equal(p('codex', 'c1', chatDir).dir, undefined);
});

/**
 * 标题只取正文——末尾那段附件清单是写给 agent 的，不该出现在标题里。
 *
 * 2026-09-24 实测：会话「只回复两个字：收到」在侧栏和页头上显示成
 *
 *   只回复两个字：收到 附件（已放在工作目录下）： - .baton-uploads/report.xlsx（12 B） - …
 *
 * 因为标题是从第一条消息派生的，而那条消息末尾带着清单。在**服务端**切，
 * 三端一次都对（app / web / 桌面 App 拿的都是这个 title）；放到各客户端去切
 * 就是三份各写一遍。
 *
 * 用数组 join 拼多行，不写 '\n'：这个仓库里用 Python heredoc 生成 JS 的做法
 * 已经把转义吃掉过好几次（docs 里记过），拼出来的字面量当场就是坏的。
 */
const listed = (...lines) => ['', '附件（已放在工作目录下）：', ...lines].join('\n');

test('标题不带末尾那段附件清单', () => {
  const msg = ['只回复两个字：收到', ...listed(
    '- .baton-uploads/report.xlsx（12 B）',
    '- .baton-uploads/截图.png（8 B）',
  ).split('\n')].join('\n');
  const r = resolveTitle({ agent: 'claude', firstUserText: msg, cwd: 'C:/x', firstTs: '2026-09-24' });
  assert.equal(r.title, '只回复两个字：收到');
});

test('只发文件没写字时，用文件名当标题', () => {
  // 第一条消息可以只有附件（新建页现在允许），那时切完正文是空的。
  // 退回「目录 · 日期」没用；文件名才说得出这条会话是干嘛的。
  const one = resolveTitle({
    agent: 'claude', cwd: 'C:/x', firstTs: '2026-09-24',
    firstUserText: listed('- .baton-uploads/report.xlsx（12 B）').trimStart(),
  });
  assert.equal(one.title, 'report.xlsx');

  const many = resolveTitle({
    agent: 'claude', cwd: 'C:/x', firstTs: '2026-09-24',
    firstUserText: listed(
      '- .baton-uploads/a.png（1 KB）',
      '- .baton-uploads/b.png（2 KB）',
      '- .baton-uploads/c.png（3 KB）',
    ).trimStart(),
  });
  assert.equal(many.title, 'a.png 等 3 个文件');
});

test('格式对不上就别切——宁可标题长，也不能吞掉人真写的话', () => {
  const msg = ['我想说说 附件（已放在工作目录下）：', '这不是清单'].join('\n');
  const r = resolveTitle({ agent: 'claude', firstUserText: msg, cwd: 'C:/x', firstTs: '2026-09-24' });
  assert.match(r.title, /这不是清单/);
});
