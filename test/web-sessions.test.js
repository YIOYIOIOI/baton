// 网页端会话列表的分组与排序。
//
// 和 web-tools.test.js 同一条路子：`web/src/sessions.ts` 是纯函数、不碰 DOM、
// 不 import css，Node 24 直接 import .ts 就能跑。零新依赖。
//
// **为什么这段值得测**：它被真实数据打脸过两次，两次都是「照直觉写必错」——
//
//   1. 一条链里可能有**好几个** `parentId === null` 的成员（实测有 2 个的、3 个的）。
//      「一条链一个根」不成立，照它建树必有成员挂不上去
//   2. 根**不一定在 members[0]**（实测出现在第 1、第 2 位）
//
// 取样：线上 170 条链 / 184 个成员，其中 10 条是多成员链（4、3、3、2×7）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { ago, dirKey, dirLabel, dotKind, group, whereLabel } from '../web/src/sessions.ts';

/* ── 造数据 ───────────────────────────────────────────────────────────────── */

let seq = 0;
function member(over = {}) {
  seq += 1;
  return {
    key: `k${seq}`,
    agent: 'claude',
    title: `会话 ${seq}`,
    titleTier: 0,
    cwd: 'C:\\proj',
    firstTs: '2026-09-01T00:00:00Z',
    lastTs: null,
    mtimeMs: 1000 * seq,
    size: 0,
    isArchived: false,
    parentId: null,
    providerId: `p${seq}`,
    rolloutId: null,
    running: false,
    ...over,
  };
}

function chain(members) {
  return { chainKey: members[0].providerId, agent: members[0].agent, lastActivityMs: 0, members };
}

const keysOf = (groups) => groups.map((g) => g.threads.map((t) => t.map((m) => m.key)));

/* ── 目录 ─────────────────────────────────────────────────────────────────── */

test('dirKey 大小写不敏感——C:\\ 与 c:\\ 不能裂成两组', () => {
  assert.equal(dirKey('C:\\Proj\\Baton'), dirKey('c:\\proj\\baton'));
  assert.equal(dirKey('C:\\Proj\\Baton\\'), dirKey('C:\\Proj\\Baton'));
});

test('dirLabel 取末段；没有目录时有话说', () => {
  assert.equal(dirLabel('C:\\workspace\\baton'), 'baton');
  assert.equal(dirLabel('/home/u/proj/'), 'proj');
  assert.equal(dirLabel(null), '没有目录');
});

/*
  worktree 会话和原仓库归到同一组。服务端给每个会话提供 `project`，分组只认它。
*/
test('按服务端给的 project 分组：worktree 会话和原仓库的会话在一组，组名是仓库名', () => {
  const site = { key: 'c:\\workspace\\website', name: 'website' };
  const g = group([
    chain([member({ key: 'wt', cwd: 'C:\\workspace\\website\\.claude\\worktrees\\wt-alpha', project: site })]),
    chain([member({ key: 'main', cwd: 'C:\\workspace\\website', project: site })]),
  ], 'all', true, '');
  assert.equal(g.length, 1);
  assert.equal(g[0].label, 'website');
  assert.equal(g[0].count, 2);
});

test('Codex 独立聊天：各自的随机目录归到同一组', () => {
  const chats = { key: 'codex:chats', name: 'Codex 独立聊天' };
  const g = group([
    chain([member({ agent: 'codex', cwd: 'C:\\Users\\u\\Documents\\Codex\\2026-09-21\\chat-1', project: chats })]),
    chain([member({ agent: 'codex', cwd: 'C:\\Users\\u\\Documents\\Codex\\2026-08-31\\chat-2', project: chats })]),
  ], 'all', true, '');
  assert.deepEqual(g.map((x) => [x.label, x.count]), [['Codex 独立聊天', 2]]);
});

test('老服务端没有 project 字段时退回按 cwd 分组', () => {
  const g = group([chain([member({ cwd: 'C:\\workspace\\baton' })])], 'all', true, '');
  assert.deepEqual(g.map((x) => [x.key, x.label]), [['c:\\workspace\\baton', 'baton']]);
});

test('搜索也认组名：worktree 会话用仓库名搜得到', () => {
  const g = group([chain([member({
    title: 'Responsive layout', cwd: 'C:\\x\\.claude\\worktrees\\wt-alpha',
    project: { key: 'c:\\workspace\\website', name: 'website' },
  })])], 'all', true, 'website');
  assert.equal(g.length, 1);
});

test('页头的「在哪儿」：App 归到别处的说 App 的名字，平常还是 cwd 末两段', () => {
  const wt = member({
    cwd: 'C:\\workspace\\website\\.claude\\worktrees\\wt-alpha',
    project: { key: 'c:\\workspace\\website', name: 'website' },
  });
  assert.equal(whereLabel(wt), 'website');
  const chat = member({ cwd: 'C:\\Users\\u\\Documents\\Codex\\2026-09-21\\chat-1', project: { key: 'codex:chats', name: 'Codex 独立聊天' } });
  assert.equal(whereLabel(chat), 'Codex 独立聊天');
  const plain = member({ cwd: 'C:\\workspace\\baton', project: { key: 'c:\\workspace\\baton', name: 'baton' } });
  assert.equal(whereLabel(plain), 'workspace\\baton');
  assert.equal(whereLabel(member({ cwd: 'C:\\workspace\\baton' })), 'workspace\\baton', '老服务端');
});

test('同一目录的不同大小写写法归进一组', () => {
  const g = group(
    [chain([member({ cwd: 'C:\\Proj' })]), chain([member({ cwd: 'c:\\proj' })])],
    'all', true, '',
  );
  assert.equal(g.length, 1);
  assert.equal(g[0].count, 2);
});

/* ── 链：不建树 ───────────────────────────────────────────────────────────── */

test('同链成员排在一起，最早的在前', () => {
  const root = member({ key: 'root', mtimeMs: 100 });
  const f1 = member({ key: 'f1', mtimeMs: 300, parentId: root.providerId });
  const f2 = member({ key: 'f2', mtimeMs: 200, parentId: root.providerId });
  // 故意把顺序打乱传进去
  const g = group([chain([f1, root, f2])], 'all', true, '');
  assert.deepEqual(keysOf(g), [[['root', 'f2', 'f1']]]);
});

test('根不在 members[0] 也照样排对——实测它出现在第 1、第 2 位', () => {
  const fork = member({ key: 'fork', mtimeMs: 900, parentId: 'x' });
  const root = member({ key: 'root', mtimeMs: 100 });
  const g = group([chain([fork, root])], 'all', true, '');
  assert.deepEqual(keysOf(g), [[['root', 'fork']]]);
});

test('一条链里有多个 parentId === null 也不会崩、不丢成员', () => {
  // 实测：两条链各有 2 个这样的成员，一条有 3 个。
  // 「一条链一个根」这个前提不成立，所以这里压根不找根，只按时间排。
  const a = member({ key: 'a', mtimeMs: 300, parentId: null });
  const b = member({ key: 'b', mtimeMs: 100, parentId: null });
  const c = member({ key: 'c', mtimeMs: 200, parentId: null });
  const g = group([chain([a, b, c])], 'all', true, '');
  assert.deepEqual(keysOf(g), [[['b', 'c', 'a']]]);
  assert.equal(g[0].count, 3);
});

test('组内按「这条链最近动过没有」排，不是按链里最早那条', () => {
  // 老链昨天刚动过，新链更早就停了——老链应该在上面
  const oldRoot = member({ key: 'old-root', mtimeMs: 10 });
  const oldTip = member({ key: 'old-tip', mtimeMs: 9000, parentId: oldRoot.providerId });
  const fresh = member({ key: 'fresh', mtimeMs: 5000 });
  const g = group([chain([oldRoot, oldTip]), chain([fresh])], 'all', true, '');
  assert.deepEqual(keysOf(g), [[['old-root', 'old-tip'], ['fresh']]]);
});

/* ── 筛选 ─────────────────────────────────────────────────────────────────── */

test('隐藏归档时，链里活下来的成员仍然成组', () => {
  // 实测存在「根已归档、分叉没归档」的链。此时分叉会单独出现——
  // 界面靠 parentId 把它标成分叉，这里只保证它不被连坐删掉
  const root = member({ key: 'root', mtimeMs: 100, isArchived: true });
  const fork = member({ key: 'fork', mtimeMs: 200, parentId: root.providerId });
  const g = group([chain([root, fork])], 'all', false, '');
  assert.deepEqual(keysOf(g), [[['fork']]]);
  assert.equal(g[0].threads[0][0].parentId, root.providerId, '分叉标记要认的就是这个字段');
});

test('整条链都被滤掉时不留空组', () => {
  const g = group([chain([member({ isArchived: true })])], 'all', false, '');
  assert.deepEqual(g, []);
});

test('按 agent 筛', () => {
  const g = group(
    [chain([member({ key: 'c1', agent: 'claude' })]), chain([member({ key: 'x1', agent: 'codex' })])],
    'codex', true, '',
  );
  assert.deepEqual(keysOf(g), [[['x1']]]);
});

test('搜索同时匹配标题与目录——记不住标题时凭「在哪个项目」也要能找回来', () => {
  const byTitle = group([chain([member({ title: '修复优惠码' })])], 'all', true, '优惠');
  assert.equal(byTitle.length, 1);
  const byDir = group([chain([member({ title: '无关', cwd: 'C:\\shop-web' })])], 'all', true, 'shop');
  assert.equal(byDir.length, 1);
  const miss = group([chain([member({ title: '无关', cwd: 'C:\\a' })])], 'all', true, '没有这个');
  assert.equal(miss.length, 0);
});

test('搜索大小写不敏感，且首尾空白不算数', () => {
  const g = group([chain([member({ title: 'Baton WebUI' })])], 'all', true, '  webui  ');
  assert.equal(g.length, 1);
});

/* ── 组排序 ───────────────────────────────────────────────────────────────── */

test('组按各自最近的活动排，新的在上', () => {
  const g = group(
    [chain([member({ cwd: 'C:\\old', mtimeMs: 100 })]), chain([member({ cwd: 'C:\\new', mtimeMs: 900 })])],
    'all', true, '',
  );
  assert.deepEqual(g.map((x) => x.label), ['new', 'old']);
});

/* ── 时间文案 ─────────────────────────────────────────────────────────────── */

test('ago 分档', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0);
  assert.equal(ago(now, now), '刚刚');
  assert.equal(ago(now - 30_000, now), '刚刚');
  assert.equal(ago(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(ago(now - 3 * 3600_000, now), '3 小时前');
  assert.equal(ago(now - 2 * 86_400_000, now), '2 天前');
  // 超过一周给日期，不再说「45 天前」
  assert.match(ago(now - 40 * 86_400_000, now), /月 \d+ 日$/);
});

test('ago 对未来时间不给负数——时钟偏差是常态', () => {
  const now = Date.now();
  assert.equal(ago(now + 60_000, now), '刚刚');
});

test('圆点三态：在跑 / 等你 / 闲着；传输轴的事由各端自己管', () => {
  assert.equal(dotKind(member({ running: true })), ' is-running');
  assert.equal(dotKind(member({ waiting: true })), ' is-waiting');
  assert.equal(dotKind(member()), '');
  assert.equal(dotKind(member({ running: true, waiting: true })), ' is-running', '撞上了按在跑算');
});

/*
  组头「在这里开新会话」：目录取组本身，worktree 会话自己的 cwd 是 worktree，不能拿来用；agent 取这组最近动过的那条。
*/
test('组头「在这里开新会话」：目录是组本身的（不是 worktree），agent 取最近那条；独立聊天没有目录', () => {
  const site = { key: 'c:\\workspace\\website', name: 'website', dir: 'C:\\workspace\\website' };
  const [g] = group([
    chain([member({ key: 'wt', agent: 'claude', mtimeMs: 1, cwd: 'C:\\workspace\\website\\.claude\\worktrees\\x', project: site })]),
    chain([member({ key: 'cx', agent: 'codex', mtimeMs: 9, cwd: 'C:\\workspace\\website', project: site })]),
  ], 'all', true, '');
  assert.equal(g.newDir, 'C:\\workspace\\website');
  assert.equal(g.newAgent, 'codex');
  const [chats] = group([chain([member({ agent: 'codex', cwd: 'C:\\chat', project: { key: 'codex:chats', name: 'Codex 独立聊天' } })])], 'all', true, '');
  assert.equal(chats.newDir, null);
  const [old] = group([chain([member({ cwd: 'C:\\workspace\\baton' })])], 'all', true, '');
  assert.equal(old.newDir, 'C:\\workspace\\baton', '老服务端没有 project：用会话自己的目录');
});
