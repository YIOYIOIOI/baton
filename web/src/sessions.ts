import type { Agent, Chain, Member } from './api';

/**
 * 会话列表的分组、排序与时间文案。
 *
 * **和 Shell.tsx 分开是为了能测。** 这里是纯函数、不碰 DOM、不 import css，
 * 于是 Node 24 能直接 import 这个 .ts 跑断言（见 test/web-sessions.test.js）。
 * 留在 Shell.tsx 里的话，那句 `import './workspace.css'` 就把测试挡在门外了。
 *
 * 值得测，是因为**这段逻辑被真实数据打脸过两次**，两次都是「照直觉写必错」：
 * 见下面 Thread 的抬头。
 */

export type Filter = 'all' | 'claude' | 'codex' | 'antigravity';

/**
 * 一条链里活下来的成员，最早的在前。
 *
 * **不建树。** 实测 10 条多成员链里，有两条含 2 个 `parentId === null` 的成员、
 * 一条含 3 个——「一条链一个根」这个前提不成立，照它建树必然有成员挂不上去。
 * 而且根**不一定在 `members[0]`**（实测出现在第 1、第 2 位）。
 *
 * 所以只做数据撑得住的那部分：同链成员相邻、按时间排、非最早的在界面上标成分叉。
 * 「这几条是一家的」数据答得上来；「A 生了 B」答不上来，就不说。
 */
export type Thread = Member[];

export type Group = {
  key: string;
  label: string;
  cwd: string | null;
  /**
   * 组头上「在这里开新会话」开在哪个目录、默认用哪个 agent（2026-11-11）。目录是组本身的目录
   * （worktree 会话归在原仓库下，它自己的 cwd 是 worktree，不能拿来用）；Codex 独立聊天那组没有一个目录，是 null。
   * agent 取这一组最近动过的那条——在这个项目里一直用 Codex 的，新开的多半也是 Codex
   */
  newDir: string | null;
  newAgent: Agent;
  threads: Thread[];
  /** 这一组里的会话总数（不是链数）——分组标题右边显示的就是它 */
  count: number;
  latest: number;
};

export function dirLabel(cwd: string | null): string {
  if (!cwd) return '没有目录';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

/**
 * 末尾两段，给会话页头那种「只有一行位置」的地方用。
 *
 * **Baton 自己的界面一处都不显示宿主的绝对路径**——那是主人机器的目录结构，
 * 访客没道理看到。只有一段（`dirLabel`）在页头上又太少：owner 有 30 个目录，
 * 光一个 `baton` 认不出是哪条线。两段是够用的最小量。
 *
 * **这条只管 Baton 自己的界面。** agent 的输出里本来就有绝对路径
 * （`cd /c/Users/...` 那类），那是内容不是外壳，改不了也不该改——
 * 所以这不是「访客看不到任何路径」，是「Baton 不主动展示宿主结构」。
 */
export function dirTrail(cwd: string | null): string {
  if (!cwd) return '没有目录';
  const sep = cwd.includes('\\') ? '\\' : '/';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? parts.join(sep) : parts.slice(-2).join(sep);
}

/** Windows 路径大小写不敏感，同一个目录不能因为盘符大小写不同裂成两组。 */
export function dirKey(cwd: string | null): string {
  return (cwd ?? '').replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 会话归哪一组。**跟 App 侧栏一样分**：服务端给的 `project`（worktree 会话归原仓库、
 * Codex 独立聊天归一组）；老服务端没有这个字段，就退回按 cwd。
 *
 * 服务端给的 `project` 用来保证 worktree 会话（如 `.claude/worktrees/wt-alpha`）
 * 仍归属在原仓库目录下，Codex 独立聊天归到统一一组。
 */
export function groupOf(m: Member): { key: string; label: string } {
  if (m.project) return { key: m.project.key, label: m.project.name };
  return { key: dirKey(m.cwd), label: dirLabel(m.cwd) };
}

/**
 * 那颗圆点该是什么样：在跑（拍球）/ 在等你点确认（实心不动）/ 闲着（空心）。
 *
 * `running` 现在也包括**电脑上**起的轮次（服务端 runtime/live.js）；`waiting`
 * 是 CLI 报的 `waiting / input needed`，老服务端没有这个字段。
 */
export function dotKind(m: Member): string {
  if (m.running) return ' is-running';
  if (m.waiting) return ' is-waiting';
  return '';
}

/**
 * 会话页头上那行「在哪儿」。平常是 cwd 末两段（见 dirTrail）；但若服务端把
 * 归属指向了原仓库或独立聊天组，优先显示组名（避免页头冒出 `wt-alpha` 等临时目录名）。
 */
export function whereLabel(m: Member): string {
  if (m.project && m.project.name !== dirLabel(m.cwd)) return m.project.name;
  return dirTrail(m.cwd);
}

export function ago(ms: number, now: number, locale: 'en' | 'zh' = 'zh'): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (locale === 'en') {
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ms));
  }
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} 天前`;
  const date = new Date(ms);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function group(chains: Chain[], filter: Filter, showArchived: boolean, q: string): Group[] {
  const needle = q.trim().toLowerCase();
  const byDir = new Map<string, Group>();

  for (const chain of chains) {
    const kept = chain.members.filter((m) => {
      if (!showArchived && m.isArchived) return false;
      if (filter !== 'all' && m.agent !== filter) return false;
      // 标题、目录、组名都参与匹配：记不住标题时，凭「在哪个项目」也能找回来
      const hay = `${m.title} ${m.cwd ?? ''} ${m.project?.name ?? ''}`;
      if (needle && !hay.toLowerCase().includes(needle)) return false;
      return true;
    });
    if (kept.length === 0) continue;

    // 同链成员一定同目录（实测 10 条多成员链无一跨目录），取任一成员的都一样
    const { key, label } = groupOf(kept[0]);
    let g = byDir.get(key);
    if (!g) {
      const p = kept[0].project;
      g = {
        key, label, cwd: kept[0].cwd, newDir: p ? p.dir ?? null : kept[0].cwd, newAgent: kept[0].agent,
        threads: [], count: 0, latest: 0,
      };
      byDir.set(key, g);
    }
    // 最早的在前：分叉一定晚于它分出来的那条，所以时间序就是「原件 → 分支」
    const sorted = [...kept].sort((a, b) => a.mtimeMs - b.mtimeMs);
    g.threads.push(sorted);
    g.count += sorted.length;
    const newest = sorted[sorted.length - 1].mtimeMs;
    if (newest > g.latest) {
      g.latest = newest;
      g.newAgent = sorted[sorted.length - 1].agent;
    }
  }

  const groups = [...byDir.values()];
  for (const g of groups) {
    // 组内按「这条链最近动过没有」排，不是按链里最早那条——否则一条三个月前
    // 开的链哪怕昨天刚动过，也会沉到底下
    g.threads.sort((a, b) => b[b.length - 1].mtimeMs - a[a.length - 1].mtimeMs);
  }
  groups.sort((a, b) => b.latest - a.latest);
  return groups;
}
