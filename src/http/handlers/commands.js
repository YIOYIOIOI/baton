// 输入框里打 `/` 弹出来的命令表（2026-11-10；11-11 加上 Codex；11-17 加上 Antigravity）。命令从哪来见 src/agent/commands.js。

import { claudeCommands, codexCommands, antigravityCommands } from '../../agent/commands.js';
import { errorBody } from '../errors.js';

/**
 * 这个会话能用的斜杠命令 / 技能。
 *
 * `?probe=1` 才会在记录里没有时去问 agent（Claude 起探针约 4 秒，Codex 起 app-server 一两秒，
 * Antigravity 直读盘零延迟）。
 *
 * `mention` 是选中之后插进输入框的那个记号：Claude 与 Antigravity 认 `/名字`，Codex 认 `$名字`
 * （实测见 agent-protocol §19）。
 */
export async function listCommands({
  repo, key, query, commands = claudeCommands, codex = codexCommands, antigravity = antigravityCommands,
}) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  const mention = member.agent === 'codex' ? '$' : '/';
  if (member.agent === 'antigravity') {
    const r = await antigravity({ cwd: member.cwd ?? '' });
    return { status: 200, body: { agent: member.agent, mention, ...r } };
  }
  if (!member.cwd) return { status: 200, body: { agent: member.agent, mention, commands: [], at: null, stale: false } };
  const probe = query?.get?.('probe') === '1';
  const r = member.agent === 'codex'
    ? await codex({ cwd: member.cwd, probe })
    : await commands({ cwd: member.cwd, probe });
  return { status: 200, body: { agent: member.agent, mention, ...r } };
}
