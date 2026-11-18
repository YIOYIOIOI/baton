import type { AgentUsage, UsageWindow } from './types';

/**
 * 套餐额度的纯函数：换算剩余、挑最紧的那个窗口、把时间说成人话。
 *
 * 和电脑网页端 web/src/Usage.tsx 是同一套口径，**措辞照抄**——同一个数在两块屏上
 * 说法不同，读起来像两件事（owner：「用量的显示方式要改成剩余用量，而不是消耗量」）。
 * 抽成纯函数是为了能单测：「几小时后重置」这种文案最容易在边界上错一位。
 */

export const PLAN: Record<string, string> = {
  pro: 'Pro', max: 'Max', plus: 'Plus', team: 'Team', enterprise: 'Enterprise', free: 'Free',
};

/** 剩余百分比，0–100 的整数。服务端给的是已用 */
export function leftOf(w: UsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(100 - w.percent)));
}

/** 三成以上正常、一成到三成警示、一成以下危险——和网页端 level() 一致 */
export type Level = 'ok' | 'mid' | 'high';
export function levelOf(left: number): Level {
  if (left <= 10) return 'high';
  if (left <= 30) return 'mid';
  return 'ok';
}

/**
 * 最紧的那个窗口：剩余最少的。设置页那一行只摆一个数，摆的就是它——
 * 「5 小时内还剩 80%、本周还剩 6%」时，真正卡人的是后者。
 */
export function tightest(u: AgentUsage): UsageWindow | null {
  if (!u.available || !u.windows.length) return null;
  return u.windows.reduce((a, b) => (leftOf(b) < leftOf(a) ? b : a));
}

/** 「2 小时 14 分钟后重置」「明天 07:00 重置」「周四 11/19 07:00 重置」 */
export function resetLabel(ms: number | null, now: number, locale: 'en' | 'zh' = 'zh'): string | null {
  if (!ms) return null;
  const d = ms - now;
  if (d <= 0) return locale === 'en' ? 'Reset' : '已重置';
  const min = Math.round(d / 60_000);
  if (min < 60) return locale === 'en' ? `Resets in ${min}m` : `${min} 分钟后重置`;
  const h = Math.floor(min / 60);
  if (h < 24) return locale === 'en' ? `Resets in ${h}h ${min % 60}m` : `${h} 小时 ${min % 60} 分钟后重置`;
  const t = new Date(ms);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (locale === 'en') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return h < 48
      ? `Resets tomorrow ${hm}`
      : `Resets ${days[t.getDay()]} ${t.getMonth() + 1}/${t.getDate()} ${hm}`;
  }
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return h < 48 ? `明天 ${hm} 重置` : `${days[t.getDay()]} ${t.getMonth() + 1}/${t.getDate()} ${hm} 重置`;
}

/** 「刚刚」「12 分钟前」「3 小时前」「2 天前」 */
export function agoLabel(ms: number | null, now: number, locale: 'en' | 'zh' = 'zh'): string | null {
  if (!ms) return null;
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return locale === 'en' ? 'just now' : '刚刚';
  if (min < 60) return locale === 'en' ? `${min}m ago` : `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 48) return locale === 'en' ? `${h}h ago` : `${h} 小时前`;
  const d = Math.round(h / 24);
  return locale === 'en' ? `${d}d ago` : `${d} 天前`;
}

/** 现问失败、退回了上一轮记下的旧数（只有 Codex 会这样） */
export function isStale(u: AgentUsage): boolean {
  return u.available && u.source === 'rollout';
}
