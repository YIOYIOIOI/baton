import { dotKind, groupChains, groupOf } from '../groups';
import type { Chain, Member } from '../types';

/**
 * 首页分组跟 App 侧栏一样分，一个会话一行。
 *
 * worktree 会话应归入原仓库组，而不是单独成组（如 `wt-alpha`）；
 * Codex 的独立聊天归入统一聊天组，不按临时目录拆散。服务端现在给每个会话一个 `project`。
 *
 * 2026-10-08 owner：「各占一行确实是对的」——分叉不再折进原件那一行。
 */

let seq = 0;
function member(over: Partial<Member> = {}): Member {
  seq += 1;
  return {
    key: `k${seq}`, agent: 'claude', providerId: `p${seq}`, rolloutId: null, size: 0, mtimeMs: seq,
    parentId: null, cwd: 'C:\\proj', firstTs: null, lastTs: null, title: `会话 ${seq}`, titleTier: 1,
    isArchived: false, running: false, ...over,
  };
}
const chain = (members: Member[]): Chain => ({
  chainKey: members[0].providerId,
  agent: members[0].agent,
  lastActivityMs: Math.max(...members.map((m) => m.mtimeMs)),
  members,
});
const keysOf = (gs: ReturnType<typeof groupChains>) => gs.map((g) => g.rows.map((r) => r.member.key));

const SITE = { key: 'c:\\workspace\\website', name: 'website' };

test('worktree 会话和原仓库的会话在一组，组名是仓库名', () => {
  const groups = groupChains([
    chain([member({ cwd: 'C:\\workspace\\website\\.claude\\worktrees\\wt-alpha', project: SITE })]),
    chain([member({ cwd: 'C:\\workspace\\website', project: SITE })]),
  ], 'all', false);
  expect(groups.map((g) => [g.name, g.rows.length])).toEqual([['website', 2]]);
});

test('Codex 独立聊天归一组', () => {
  const chats = { key: 'codex:chats', name: 'Codex 独立聊天' };
  const groups = groupChains([
    chain([member({ agent: 'codex', cwd: 'C:\\Users\\u\\Documents\\Codex\\2026-09-21\\shen', project: chats })]),
    chain([member({ agent: 'codex', cwd: 'C:\\Users\\u\\Documents\\Codex\\2026-08-31\\bang', project: chats })]),
  ], 'all', false);
  expect(groups.map((g) => [g.key, g.name, g.rows.length])).toEqual([['codex:chats', 'Codex 独立聊天', 2]]);
});

test('同名不同路径的两个文件夹不再合成一组——归组认 key，不认名字', () => {
  const groups = groupChains([
    chain([member({ project: { key: 'c:\\a\\notes', name: 'notes' } })]),
    chain([member({ project: { key: 'd:\\b\\notes', name: 'notes' } })]),
  ], 'all', false);
  expect(groups).toHaveLength(2);
});

test('老服务端没有 project 字段时退回按 cwd 末段', () => {
  expect(groupOf(member({ cwd: 'C:\\workspace\\baton\\' }))).toEqual({ key: 'baton', name: 'baton' });
  expect(groupOf(member({ cwd: null })).name).toBe('（无目录）');
});

// ── 一个会话一行 ────────────────────────────────────

test('分叉各占一行，同链的排在一起，最早的在前', () => {
  const root = member({ key: 'root', mtimeMs: 100 });
  const f1 = member({ key: 'f1', mtimeMs: 300, parentId: root.providerId });
  const f2 = member({ key: 'f2', mtimeMs: 200, parentId: root.providerId });
  // 故意把顺序打乱传进去
  const g = groupChains([chain([f1, root, f2])], 'all', false);
  expect(keysOf(g)).toEqual([['root', 'f2', 'f1']]);
  expect(g[0].rows.map((r) => r.fork)).toEqual([false, true, true]);
});

test('原件最后动过、排在分叉后面时，它仍然不是分叉', () => {
  // 实测的那条链：分叉(归档) → 分叉 → 原件。排第几和有没有父指针是两回事，
  // 照「排在后面的都算分叉」写，原件会被标成分叉。
  const root = member({ key: 'root', mtimeMs: 900 });
  const f1 = member({ key: 'f1', mtimeMs: 100, parentId: root.providerId });
  const g = groupChains([chain([root, f1])], 'all', false);
  expect(keysOf(g)).toEqual([['f1', 'root']]);
  expect(g[0].rows.map((r) => r.fork)).toEqual([true, false]);
});

test('原件被「隐藏已归档」滤掉时，剩下的分叉仍标成分叉', () => {
  const root = member({ key: 'root', mtimeMs: 100, isArchived: true });
  const fork = member({ key: 'fork', mtimeMs: 200, parentId: root.providerId });
  const g = groupChains([chain([root, fork])], 'all', false);
  expect(keysOf(g)).toEqual([['fork']]);
  expect(g[0].rows[0].fork).toBe(true);
});

test('整条链都被滤掉时不留空组', () => {
  expect(groupChains([chain([member({ isArchived: true })])], 'all', false)).toEqual([]);
});

test('组内按链最近活动排；在跑的会话逐个计数', () => {
  const oldRoot = member({ key: 'old-root', mtimeMs: 10, project: { key: 'a', name: 'a' }, running: true });
  const oldTip = member({ key: 'old-tip', mtimeMs: 9000, project: { key: 'a', name: 'a' }, parentId: oldRoot.providerId, running: true });
  const fresh = member({ key: 'fresh', mtimeMs: 5000, project: { key: 'a', name: 'a' } });
  const g = groupChains([chain([oldRoot, oldTip]), chain([fresh])], 'all', false);
  expect(keysOf(g)).toEqual([['old-root', 'old-tip', 'fresh']]);
  expect(g[0].running).toBe(2);
});

test('默认不显示归档；按 agent 筛；组按最近活动排', () => {
  const old = chain([member({ project: { key: 'a', name: 'a' }, mtimeMs: 10 })]);
  const fresh = chain([member({ project: { key: 'b', name: 'b' }, mtimeMs: 99 })]);
  const gone = chain([member({ project: { key: 'c', name: 'c' }, mtimeMs: 50, isArchived: true })]);
  const codex = chain([member({ agent: 'codex', project: { key: 'd', name: 'd' }, mtimeMs: 70 })]);
  expect(groupChains([old, fresh, gone, codex], 'all', false).map((g) => g.key)).toEqual(['b', 'd', 'a']);
  expect(groupChains([old, fresh, gone, codex], 'claude', true).map((g) => g.key)).toEqual(['b', 'c', 'a']);
});

// ── 那颗圆点 ────────────────────────────────────────

test('在跑 / 等你 / 闲着是三种，不是两种', () => {
  expect(dotKind(member({ running: true }), 'ok')).toBe('running');
  expect(dotKind(member({ waiting: true }), 'ok')).toBe('waiting');
  expect(dotKind(member(), 'ok')).toBe('idle');
  // 服务端保证两者互斥，真撞上了按在跑算——「等它」比「等你」更该先看见
  expect(dotKind(member({ running: true, waiting: true }), 'ok')).toBe('running');
});

test('传输轴死了就一律当闲着——那一刻「在跑」本身已经不可信', () => {
  for (const link of ['offline', 'origin', 'retrying']) {
    expect(dotKind(member({ running: true }), link)).toBe('idle');
    expect(dotKind(member({ waiting: true }), link)).toBe('idle');
  }
});

test('老服务端没有 waiting 字段也不会崩', () => {
  const m = member();
  delete (m as { waiting?: boolean }).waiting;
  expect(dotKind(m, 'ok')).toBe('idle');
});
