import os from 'node:os';
import path from 'node:path';
import { codexRpc } from './codexRpc.js';

/**
 * Codex 的「目标」（2026-11-11，codex-cli 0.164.0，实测见 agent-protocol §20）。
 *
 * owner：「codex 那里还是看不到目标啊」。Codex 自己有一套目标：每个会话一条，存在
 * `~/.codex/goals_1.sqlite` 的 `thread_goals`（objective / status / token_budget / tokens_used /
 * time_used_seconds），由 app-server 的 `thread/goal/set|get|clear` 读写。
 *
 * - **看**：直接读那张表（只读）。读 rollout 也能拼出来，但 token、时长只有表里有
 * - **设 / 清**：走 app-server 的官方方法，不碰它的库。实测不用先把会话载入就能设
 * - **接着干**：Codex 只在「开着这个会话的进程」里自动续（App）。`codex exec resume` 遇到 active 的目标，
 *   这一轮就是一轮目标续跑（turn_trigger: goal），干完模型自己把状态标成 complete，但 exec 不会自己再起下一轮——
 *   那一步由 Baton 做（handlers/turns.js 的 continueGoal）
 */

/** 状态在库里是蛇形，在 app-server 的消息里是驼峰。统一成蛇形 */
export function normStatus(s) {
  const map = { usageLimited: 'usage_limited', budgetLimited: 'budget_limited' };
  return typeof s === 'string' ? (map[s] ?? s) : null;
}

/**
 * 这个会话现在的目标。没有、或者库读不了，返回 null。
 *
 * @returns {Promise<{ objective: string, status: string, tokenBudget: number|null, tokensUsed: number,
 *   timeUsedSeconds: number, createdAt: number, updatedAt: number } | null>}
 */
export async function readCodexGoal(threadId, { home = os.homedir() } = {}) {
  if (!threadId) return null;
  let db;
  try {
    // 用到才载：node:sqlite 在 Node 24 里还会打一句 ExperimentalWarning，没必要每次启动都打
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path.join(home, '.codex', 'goals_1.sqlite'), { readOnly: true });
    const r = db.prepare(
      'select objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms from thread_goals where thread_id = ?',
    ).get(threadId);
    if (!r) return null;
    return {
      objective: String(r.objective),
      status: normStatus(String(r.status)),
      tokenBudget: r.token_budget == null ? null : Number(r.token_budget),
      tokensUsed: Number(r.tokens_used ?? 0),
      timeUsedSeconds: Number(r.time_used_seconds ?? 0),
      createdAt: Number(r.created_at_ms),
      updatedAt: Number(r.updated_at_ms),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 没开成
    }
  }
}

/** 设目标（并置为 active）。origin: user——这是人的操作，不是自动的 */
export async function setCodexGoal({ threadId, objective, rpc = codexRpc }) {
  const [r] = await rpc([{ method: 'thread/goal/set', params: { threadId, objective, status: 'active', origin: 'user' } }]);
  return r?.goal ?? null;
}

/** 清掉目标 */
export async function clearCodexGoal({ threadId, rpc = codexRpc }) {
  await rpc([{ method: 'thread/goal/clear', params: { threadId } }]);
}
