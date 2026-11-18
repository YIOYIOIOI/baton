/**
 * 目标的状态怎么说（2026-11-11）。Claude 的只有 active / complete；Codex 自己的目标还有暂停、卡住、
 * 额度或预算用完（服务端 src/agent/codexGoal.js，库里是蛇形）。
 */
export const GOAL_STATE: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '卡住了',
  usage_limited: '额度用完，停下了',
  budget_limited: '到了预算上限',
  complete: '已达成',
};

/** 设着、还要人管的那几种（不是 active 也不是 complete）——用提醒色 */
export function goalNeedsYou(status: string | undefined): boolean {
  return !!status && status !== 'active' && status !== 'complete';
}

/** 对话里那一行的标题。text 为空表示只改了状态（Codex 里暂停后恢复） */
export function goalRowTitle(g: { met: boolean; status?: string }, text: string): string {
  if (!g.status) return g.met ? '目标达成' : '目标还没达成，接着干';
  if (g.status === 'complete') return '目标达成';
  if (g.status === 'active') return text ? '设定了目标' : '目标恢复了';
  return `目标${GOAL_STATE[g.status] ?? g.status}`;
}

/** 秒 → 「2 小时 13 分」 */
export function fmtDuration(s: number): string {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}
