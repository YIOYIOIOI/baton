// 选择题：agent 经 MCP 问、人在手机上答（见 docs/ops/agent-protocol.md §7）。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import { normalizeAsk, ASK_HEADER } from '../../ask/protocol.js';
import { openAsk, answerAsk as answerPendingAsk, resolveAskToken } from '../../ask/store.js';
import { errorBody } from '../errors.js';

/**
 * agent 侧的入口：MCP 服务器把问题送过来，**这条响应一直挂着**，直到
 * 用户答了 / 超时 / 这一轮被停掉。挂住它就是挂住 agent 那一轮——
 * 这正是「在这一轮里等你选」的实现方式（实测 75 秒不超时，见 ask/protocol.js）。
 *
 * 身份不从请求体读，只认这一轮的一次性令牌：读了的话 agent 就能自报别人的
 * 会话，把问题推到别人的手机上。
 */
export async function postAsk({ headers, body }) {
  const who = resolveAskToken(headers?.[ASK_HEADER]);
  if (!who) {
    return {
      status: 401,
      body: errorBody('bad_ask_token', '提问令牌无效或已过期。', '这一轮已经结束了，不要再调用这个工具。'),
    };
  }
  const { ask, error } = normalizeAsk(body);
  if (error) {
    return { status: 400, body: errorBody('bad_ask', error, '改正参数后重试，或把问题写进回复正文里。') };
  }
  const { promise } = openAsk({ key: who.key, turnId: who.turnId, ...ask });
  const answer = await promise;
  return { status: 200, body: { answer } };
}

/** 用户侧的入口：答一道正在等的题。 */
export function answerAsk({ config, key, askId, picked, free }) {
  // 和发消息同一条纪律：只读模式下不能把任何东西送进 agent
  if (config.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '发送已禁用（当前配置为只读）。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  const r = answerPendingAsk({ key, askId, picked, free });
  if (r.ok) return { status: 200, body: { ok: true, picked: r.picked, free: r.free } };
  const REASONS = {
    no_pending: ['no_pending_ask', '这道题已经不在等回答了。', '可能已经超时或这一轮已结束，刷新看看。'],
    stale: ['stale_ask', '这张卡片已经过期。', '刷新一次，看现在等的是哪一道题。'],
    empty_answer: ['empty_answer', '没有选中任何选项，也没有写内容。', '选一个选项，或者自己写一句。'],
    single_only: ['single_only', '这道题只能选一个。', '只保留一个选项再提交。'],
  };
  const [code, message, hint] = REASONS[r.reason] ?? ['ask_failed', '回答失败。', '刷新一次再试。'];
  return { status: 409, body: errorBody(code, message, hint) };
}
