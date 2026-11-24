import { OWNER_ID } from '../../principals.js';
import { appendAuditEvent } from '../../audit.js';
import { isLocalRequest } from '../auth.js';
import { errorBody } from '../errors.js';
import { launchLocalTerminal, TerminalLaunchError } from '../../agent/terminal.js';

function isOwner(principal) {
  return (principal?.roots ?? null) === null && principal?.id === OWNER_ID;
}

/**
 * Open the host's local interactive terminal resumed into the target session.
 * Strictly restricted to the host owner accessing the dashboard directly via loopback.
 */
export async function openTerminal({
  repo,
  principal,
  req,
  key,
  launcher = launchLocalTerminal,
  audit = appendAuditEvent,
}) {
  if (!isOwner(principal)) {
    return {
      status: 403,
      body: errorBody(
        'owner_only',
        '只有这台电脑的主人才能打开本地终端。',
        '访客会话受限于工作区隔离，不支持拉起宿主机终端。',
      ),
    };
  }
  if (!isLocalRequest(req)) {
    return {
      status: 403,
      body: errorBody(
        'local_only',
        '只能在本地打开的看板里拉起本机终端。',
        '请在本机浏览器通过 http://127.0.0.1 或 http://localhost 打开 Baton 后再点击。',
      ),
    };
  }

  const member = repo.getSession(key);
  if (!member) {
    return {
      status: 404,
      body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。'),
    };
  }

  try {
    const result = await launcher({ member });
    try {
      audit({
        type: 'open_terminal',
        principal: principal.id,
        key,
        agent: member.agent,
        terminal: result.terminal,
        permissionMode: result.permissionMode ?? null,
        model: result.model ?? null,
        effort: result.effort ?? null,
      });
    } catch {
      // Non-fatal if audit directory is unavailable in injected tests
    }
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof TerminalLaunchError) {
      return {
        status: err.status,
        body: errorBody(err.code, err.message, err.fix),
      };
    }
    return {
      status: 500,
      body: errorBody(
        'terminal_launch_failed',
        `拉起本地终端失败：${err?.message ?? err}`,
        '检查本机终端与 agent CLI 安装状态后重试。',
      ),
    };
  }
}
