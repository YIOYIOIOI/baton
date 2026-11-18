import type { Agent, Chain, Member } from './types';

/**
 * 首页列表怎么分组、怎么排行。纯函数，单独放出来是为了能测（见 __tests__/groups.test.ts）。
 *
 * ## 分组跟 App 侧栏一样
 *
 * 服务端给每个会话一个 `project`（见 src/titles.js 的 resolveProject）：worktree 会话
 * 归原仓库、Codex 的独立聊天归一组。不再按 cwd 末段切碎（如 worktree 随机目录名或独立聊天临时目录名）。
 *
 * ## 一个会话一行，分叉也是
 *
 * 原来一条链只出一行（显示链里最后那个成员），分叉被折进去看不见。owner
 * 2026-10-08：「各占一行确实是对的」——Claude App 侧栏也是一个会话一行。
 *
 * 同链的成员**排在一起**、按时间从早到晚，于是「原件 → 分支」读起来是顺的；
 * 非最早的那几个标上「分叉」。**不建树**：实测一条链里可能有好几个
 * `parentId === null` 的成员，「一条链一个根」这个前提不成立（见 web/src/sessions.ts）。
 */

/** 一条链里活下来的成员，最早的在前。 */
export type Thread = Member[];

export type Row = { member: Member; fork: boolean };

/** `key` 只用来归组和记折叠状态；`name` 是组头上的字。 */
export type Group = { key: string; name: string; rows: Row[]; running: number };

function dirName(cwd: string | null): string {
  if (!cwd) return '（无目录）';
  // 两种分隔符都要认：Claude 的 cwd 是 Windows 路径，Codex 的可能是 POSIX
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * 那一行左边的圆点该画成什么：
 *
 *   running  在跑。**包括电脑上起的轮次**——owner 2026-10-08：「我刚刚下班，
 *            打开手机，就看不到哪些会话是还在工作的」
 *   waiting  卡在等人点确认（CLI 报 `waiting / input needed`）。是另一种状态，
 *            不是在跑的一种：一个是等它干完，一个是它在等你
 *   idle     闲着
 *
 * **传输轴死了就一律当闲着**：那一刻「它在跑」这个判断本身已经不可信了，
 * 继续画成在跑就是在说谎。
 */
export function dotKind(m: Member, link: string): 'running' | 'waiting' | 'idle' {
  if (link !== 'ok') return 'idle';
  if (m.running) return 'running';
  if (m.waiting) return 'waiting';
  return 'idle';
}

/** 老服务端没有 `project`：退回按 cwd 末段——那是改之前的行为 */
export function groupOf(m: Member): { key: string; name: string } {
  if (m.project) return m.project;
  const name = dirName(m.cwd);
  return { key: name, name };
}

/** 一条链在界面上代表自己的那个成员：最后活动的那个（用于跳转、取组名）。 */
export const head = (c: Chain): Member => c.members[c.members.length - 1] ?? c.members[0];

export function groupChains(chains: Chain[], agent: Agent | 'all', showArchived: boolean): Group[] {
  const map = new Map<string, Group & { threads: { rows: Row[]; latest: number }[] }>();

  for (const chain of chains) {
    if (agent !== 'all' && chain.agent !== agent) continue;
    const kept = chain.members.filter((m) => showArchived || !m.isArchived);
    if (kept.length === 0) continue;

    // 最早的在前：分叉一定晚于它分出来的那条，所以时间序就是「原件 → 分支」
    const sorted = [...kept].sort((a, b) => a.mtimeMs - b.mtimeMs);
    // 同链成员一定同目录（实测 10 条多成员链无一跨目录），取任一成员的都一样
    const { key, name } = groupOf(sorted[0]);
    let g = map.get(key);
    if (!g) { g = { key, name, rows: [], running: 0, threads: [] }; map.set(key, g); }

    g.threads.push({
      /*
        **有父指针才叫分叉，不看它排第几。**

        一度写成「排在后面的都算分叉」，真实数据当场打脸：一条链按时间排是
        「分叉(归档) → 分叉 → 原件」——原件最后动过，于是排在第二个分叉后面，
        被标成了分叉（2026-10-08 实测）。父指针是 transcript 首记录里实打实的
        祖先 id（见 src/claude.js 的 claudeHead），排序是显示顺序，两回事。
      */
      rows: sorted.map((member) => ({ member, fork: Boolean(member.parentId) })),
      latest: sorted[sorted.length - 1].mtimeMs,
    });
    g.running += sorted.filter((m) => m.running).length;
  }

  const groups = [...map.values()];
  for (const g of groups) {
    // 组内按「这条链最近动过没有」排，不是按链里最早那条——否则一条三个月前
    // 开的链哪怕昨天刚动过，也会沉到底下
    g.threads.sort((a, b) => b.latest - a.latest);
    g.rows = g.threads.flatMap((t) => t.rows);
  }
  groups.sort((a, b) => (b.threads[0]?.latest ?? 0) - (a.threads[0]?.latest ?? 0));
  return groups.map(({ key, name, rows, running }) => ({ key, name, rows, running }));
}
