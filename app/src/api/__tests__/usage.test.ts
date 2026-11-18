import { agoLabel, isStale, leftOf, levelOf, resetLabel, tightest } from '../usage';
import type { AgentUsage } from '../types';

/**
 * 用量的换算与文案。和电脑网页端 web/src/Usage.tsx 同一套口径——
 * 两块屏对同一个数的说法必须一样。
 */

const NOW = new Date(2026, 10, 15, 10, 0, 0).getTime();
const win = (id: string, percent: number, resetsAt: number | null = null) => ({ id, label: id, percent, resetsAt });

test('显示的是剩余，不是已用；越界的数要夹住', () => {
  expect(leftOf(win('a', 20))).toBe(80);
  expect(leftOf(win('a', 0))).toBe(100);
  expect(leftOf(win('a', 120))).toBe(0);
  expect(leftOf(win('a', -5))).toBe(100);
  expect(leftOf(win('a', 33.4))).toBe(67);
});

test('颜色档位：一成以下危险、三成以下警示', () => {
  expect(levelOf(5)).toBe('high');
  expect(levelOf(10)).toBe('high');
  expect(levelOf(11)).toBe('mid');
  expect(levelOf(30)).toBe('mid');
  expect(levelOf(31)).toBe('ok');
});

test('最紧的窗口是剩余最少的那个——真正卡人的是它', () => {
  const u: AgentUsage = {
    available: true, plan: 'max', asOf: NOW,
    windows: [win('5h', 20), win('week', 94), win('opus', 50)],
  };
  expect(tightest(u)?.id).toBe('week');
  expect(tightest({ available: true, plan: null, asOf: null, windows: [] })).toBeNull();
  expect(tightest({ available: false, reason: '没登录' })).toBeNull();
});

test('重置时间：分钟、小时、明天、星期', () => {
  expect(resetLabel(null, NOW)).toBeNull();
  expect(resetLabel(NOW - 1, NOW)).toBe('已重置');
  expect(resetLabel(NOW + 14 * 60_000, NOW)).toBe('14 分钟后重置');
  expect(resetLabel(NOW + (2 * 60 + 14) * 60_000, NOW)).toBe('2 小时 14 分钟后重置');
  expect(resetLabel(new Date(2026, 10, 16, 12, 0).getTime(), NOW)).toBe('明天 12:00 重置');
  expect(resetLabel(new Date(2026, 10, 19, 7, 5).getTime(), NOW)).toBe('周四 11/19 07:05 重置');
});

test('多久以前', () => {
  expect(agoLabel(null, NOW)).toBeNull();
  expect(agoLabel(NOW - 10_000, NOW)).toBe('刚刚');
  expect(agoLabel(NOW - 12 * 60_000, NOW)).toBe('12 分钟前');
  expect(agoLabel(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前');
  expect(agoLabel(NOW - 72 * 3_600_000, NOW)).toBe('3 天前');
});

test('只有退回 rollout 的才算旧数', () => {
  expect(isStale({ available: true, plan: null, asOf: NOW, windows: [], source: 'rollout' })).toBe(true);
  expect(isStale({ available: true, plan: null, asOf: NOW, windows: [], source: 'live' })).toBe(false);
  expect(isStale({ available: false, reason: 'x' })).toBe(false);
});
