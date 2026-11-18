import type { RunAxis, Turn, TurnStatus } from './types';

/**
 * 运行轴：后端的 5 个轮次状态 → 界面的 6 个运行态。
 *
 * 名字对不上是有原因的，不是随手起的：后端记录的是**事实**（这一轮结束时是什么
 * 结果），界面要表达的是**此刻该让用户看到什么**。差别全在 `running` 这一个状态上
 * ——它在界面上必须裂成两个：
 *
 *   streaming  在跑，而且刚刚还在出东西  →  正常，看着就行
 *   silent     在跑，但一段时间没出东西了  →  也正常（它在想），但用户需要知道
 *
 * 不裂开的话，「它在深度思考」和「它卡死了」长得一模一样——那正是同类工具
 * 最常翻车的地方，也是 Baton 立项要消灭的「永远 Thinking」。
 *
 * 区分二者**不能靠客户端计时**，要靠服务器心跳：秒表在走 = 服务端确认它还活着。
 */
const MAP: Record<Exclude<TurnStatus, 'running'>, RunAxis> = {
  ok: 'ok',
  failed: 'fail',
  aborted: 'stopped',
  anomaly: 'anomaly',
  // 交给了 Codex App 排队：Baton 这边平稳收尾，不报警。说明由结束横幅（TurnEnd）给
  handoff: 'ok',
};

/** 多久没有新事件就算「沉默」。20 秒：比一次工具调用长，比一次深度思考短。 */
export const SILENT_AFTER_MS = 20_000;

export function runAxisOf(
  turn: Turn | null,
  lastEventAt: number | null,
  now: number,
): RunAxis | null {
  if (!turn) return null;
  if (turn.status !== 'running') return MAP[turn.status];
  const since = lastEventAt ?? turn.startedAt;
  return now - since > SILENT_AFTER_MS ? 'silent' : 'streaming';
}

/**
 * 「成功结束什么都不显示」这条规矩仍然成立（原型硬性要求 1）——每轮都弹一个
 * 「✓ 完成」，滚动流里就会堆满没有信息量的绿标，真正需要注意的失败反而被淹掉。
 *
 * 但实现它的 shouldShowRunBadge() 与 RUN_LABEL 已经删了：承载它们的 RunBadge
 * 组件早被 Live 取代，两者都只剩测试在调用——一个没有生产调用方的函数配一组
 * 测试，给的是假的安全感。规矩现在由 Live 自己那句「run 不是 streaming/silent
 * 就不渲染」和 TurnEnd 的「ok 直接 return null」执行。
 */

/**
 * 界面会说谎的那一刻：运行轴说「在跑」，而传输轴已经死了。
 *
 * 这是原型里**唯一允许变响**的时刻——因为此时屏幕上的一切都不可信：
 * 秒表还在走、活动块还在动，但那些都是本地在自说自话。
 * 此时活动块退成中性、秒表变灰、标签改成「已停止更新」。
 */
export function isLying(run: RunAxis | null, stopwatchStale: boolean): boolean {
  return stopwatchStale && (run === 'streaming' || run === 'silent');
}
