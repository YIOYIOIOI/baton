import { runAxisOf, isLying, SILENT_AFTER_MS } from '../axes';
import type { Turn } from '../types';

const turn = (status: Turn['status'], startedAt = 0): Turn => ({
  key: 'k', turnId: 'T', agent: 'claude', status, startedAt,
  endedAt: null, error: null, tokens: null, eventCount: 0,
});

test('没有轮次就没有运行轴', () => {
  expect(runAxisOf(null, null, 0)).toBeNull();
});

test('running 会裂成 streaming / silent 两态', () => {
  // 不裂开的话，「它在深度思考」和「它卡死了」长得一模一样——
  // 那正是 Baton 立项要消灭的「永远 Thinking」
  const t = turn('running', 1_000_000);
  expect(runAxisOf(t, 1_000_000, 1_000_000 + 5_000)).toBe('streaming');
  expect(runAxisOf(t, 1_000_000, 1_000_000 + SILENT_AFTER_MS + 1)).toBe('silent');
});

test('没有事件时用轮次开始时刻算沉默', () => {
  const t = turn('running', 1_000_000);
  expect(runAxisOf(t, null, 1_000_000 + SILENT_AFTER_MS + 1)).toBe('silent');
});

test('后端的终态逐一映射到界面态', () => {
  expect(runAxisOf(turn('ok'), null, 0)).toBe('ok');
  expect(runAxisOf(turn('failed'), null, 0)).toBe('fail');
  expect(runAxisOf(turn('aborted'), null, 0)).toBe('stopped');
  expect(runAxisOf(turn('anomaly'), null, 0)).toBe('anomaly');
});

// 这里原来有一条「成功结束什么都不显示」的测试，测的是 shouldShowRunBadge()。
// 那个函数和它服务的 RunBadge 组件都已经删了（RunBadge 早被 Live 取代，两者
// 都只剩测试在调用）。规矩本身没变，只是改由 Live 与 TurnEnd 各自执行，
// 相应的断言在那两处。

test('「在跑」+「连接已死」= 界面在说谎，这是唯一允许变响的时刻', () => {
  expect(isLying('streaming', true)).toBe(true);
  expect(isLying('silent', true)).toBe(true);
  // 已经结束的轮次不算说谎——秒表本来就不该在走
  expect(isLying('ok', true)).toBe(false);
  expect(isLying('fail', true)).toBe(false);
  // 连接好着就更不算
  expect(isLying('streaming', false)).toBe(false);
});
