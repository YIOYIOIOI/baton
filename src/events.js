/**
 * interrupt —— 这一轮被人打断了。role 恒为 'system'，text 是**给人看的一句话**
 * （由 claude.js 从 CLI 写进 transcript 的那句英文标记翻出来，理由见那里）。
 *
 * 单开一个 kind 而不是借 role:'system' 的 text：三个客户端里有两个是按 kind 分支、
 * 其余一律当正文画的（App 的会话屏「不是 user 就是 agent 正文」），借 text 的话
 * 它会从「用户气泡」变成「agent 说的话」，换了个错法而已。
 *
 * 2026-11-10 加的两种，理由同上：
 *
 *   command_output  斜杠命令的回执（CLI 写的 `<local-command-stdout>`）：「Set model to …」
 *                   「Goal set: …」、`/context` 的整张用量表。role 恒为 'system'，text 是原文
 *   goal            /goal 的进度（CLI 写的 `goal_status` 附件）。role 恒为 'system'，
 *                   text 是目标条件，`goal` 里是 { met, reason }
 */
export const EVENT_KINDS = new Set([
  'text', 'thinking', 'tool_call', 'tool_result', 'turn_end', 'interrupt', 'command_output', 'goal',
]);

/**
 * @param {{ id: string, ts?: string | null, role: string, kind: string, text?: string,
 *   tool?: object, tokens?: object, error?: string | null, origin?: string,
 *   goal?: { met: boolean, reason: string | null, status?: string } }} e
 */
export function makeEvent({ id, ts, role, kind, text, tool, tokens, error, origin, goal }) {
  if (!EVENT_KINDS.has(kind)) throw new Error(`未知事件 kind：${kind}`);
  // goal 只在 goal 事件上出现：别的事件多一个值为 undefined 的键，按键比较的地方会对不上
  return Object.freeze({
    id, ts: ts ?? null, role, kind, text, tool, tokens, error, origin, ...(goal ? { goal } : {}),
  });
}
