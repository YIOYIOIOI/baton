// 设 / 清目标（2026-11-11）。两个 agent 一个入口，客户端不必知道两边的差别。

import { sendMessage } from './turns.js';
import { setCodexGoal, clearCodexGoal } from '../../agent/codexGoal.js';
import { errorBody } from '../errors.js';

/**
 * Claude：目标就是一条 `/goal 条件` 消息（CLI 自己会一直干到满足，agent-protocol §18）；清就是 `/goal clear`。
 * Codex：走 app-server 的 `thread/goal/set|clear`（agent-protocol §20），设完立刻发一轮开工——
 *   发的就是目标原文：那一轮 exec 会带上目标上下文当成目标续跑，对话里也留下「你说了什么」。
 *   之后每轮结束、目标还 active，由 turns.js 的 continueGoal 接着起下一轮。
 *
 * 和发消息同一道闸：只读模式（allowSend=false）下不让设——设了就会开始跑。访客看不到的会话
 * repo.getSession 本来就拿不到。
 */
export async function setGoal({
  repo, config, principal, principalOf = null, key, objective, clear = false,
  send = sendMessage, codex = { set: setCodexGoal, clear: clearCodexGoal },
}) {
  if (config.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '发送已禁用（当前配置为只读）。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }

  if (clear) {
    if (member.agent === 'claude' || member.agent === 'antigravity') {
      return send({ repo, config, principal, principalOf, key, message: '/goal clear' });
    }
    try {
      await codex.clear({ threadId: member.providerId });
    } catch (err) {
      return { status: 502, body: errorBody('goal_failed', `清目标没成：${err.message}`, '过一会儿再试，或在 Codex App 里清。') };
    }
    return { status: 200, body: { cleared: true } };
  }

  const text = String(objective ?? '').trim();
  if (!text) return { status: 400, body: errorBody('empty_goal', '目标是空的。', '写下要达成的条件再发。') };
  if (member.agent === 'claude' || member.agent === 'antigravity') {
    return send({ repo, config, principal, principalOf, key, message: `/goal ${text}` });
  }

  let goal;
  try {
    goal = await codex.set({ threadId: member.providerId, objective: text });
  } catch (err) {
    return { status: 502, body: errorBody('goal_failed', `设目标没成：${err.message}`, '过一会儿再试，或在 Codex App 里设。') };
  }
  const r = await send({ repo, config, principal, principalOf, key, message: text });
  return { status: r.status, body: { ...r.body, goal } };
}
