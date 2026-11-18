// 会话页右侧「信息」窗格（2026-11-10）。读什么、为什么见 src/sessioninfo.js。

import { readSessionInfo, fileEdits } from '../../sessioninfo.js';
import { claudeCatalog } from '../../agent/catalog.js';
import { readCodexGoal } from '../../agent/codexGoal.js';
import { errorBody } from '../errors.js';

/**
 * 这个会话的信息：模型、上下文用量、目标、计划、收尾总结、改过的文件、分支。
 * `?file=<相对路径>` 换成那个文件在这个会话里的每一次改动。
 */
export async function getSessionInfo({ repo, key, query, catalog = claudeCatalog, codexGoal = readCodexGoal }) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  const file = query?.get?.('file');
  if (file) return { status: 200, body: { file, edits: fileEdits(member, file) } };

  // 上下文窗口：Claude 照 Claude Code 自己的模型目录；Antigravity 实测 ACP usage_update.size 为 1M
  let cat;
  const windowOf = (id) => {
    if (member.agent === 'antigravity') return 1_048_576;
    if (member.agent !== 'claude') return null;
    cat ??= catalog() ?? { models: [] };
    return cat.models.find((m) => m.id === id)?.contextWindow ?? null;
  };
  const info = readSessionInfo(member, { windowOf });
  if (!info) {
    return { status: 404, body: errorBody('no_transcript', '这个会话的记录文件读不到。', '回列表刷新一次。') };
  }
  /*
    目标。Claude 的从会话文件里读（goal_status 附件，sessioninfo.js）；Codex 的读它自己那张表——
    状态、已用 token、时长都在那儿，会话文件里只有设定那一刻（agent-protocol §20）
  */
  /** @type {any} */
  let goal = info.goal ? { ...info.goal, status: info.goal.met ? 'complete' : 'active' } : null;
  if (member.agent === 'codex') {
    const g = await codexGoal(member.providerId);
    goal = g ? {
      condition: g.objective,
      met: g.status === 'complete',
      reason: null,
      setAt: new Date(g.createdAt).toISOString(),
      status: g.status,
      tokensUsed: g.tokensUsed,
      timeUsedSeconds: g.timeUsedSeconds,
      tokenBudget: g.tokenBudget,
    } : null;
  }
  return { status: 200, body: { ...info, goal } };
}
