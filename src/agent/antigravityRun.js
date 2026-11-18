import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { antigravityApp, antigravityEvents, GEMINI_ROOT } from '../antigravity.js';
import { antigravitySessionFiles } from '../providers.js';
import { parseLines } from '../jsonl.js';
import { BATON_DIR } from '../config.js';
import { antigravityModelSupportsEffort, buildAntigravityArgs, buildAntigravityNewArgs } from './args.js';
import { findAgyBinary, withAgyEnv } from './agy.js';
import { killChildTree, runProcess } from './spawn.js';
import { summarizeTurn } from './adapt.js';
import {
  DEFAULT_GEMINI_CONFIG, callBridge, findLiveBridge, resolveAntigravityProjectId,
} from './antigravityBridge.js';

export { findAgyBinary };

export const BRIDGE_OR_CLI_MISSING_MSG = '未检测到运行中的 Antigravity 桌面桥接服务（baton-bridge），且本机未安装 agy 命令行。'
  + '请确认已打开 Antigravity 桌面端（首次部署 baton-bridge 插件后重启一次 Antigravity 桌面端即可自动加载），'
  + '或安装 agy CLI 后重试。';

const delay = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

function detectProduct(member) {
  const rel = typeof member?.relPath === 'string' ? member.relPath : '';
  const file = typeof member?.file === 'string' ? member.file : '';
  if (rel.startsWith('antigravity-cli/') || file.includes(`${path.sep}antigravity-cli${path.sep}`)) {
    return 'antigravity-cli';
  }
  if (rel.startsWith('antigravity-ide/') || file.includes(`${path.sep}antigravity-ide${path.sep}`)) {
    return 'antigravity-ide';
  }
  return 'antigravity';
}

function readTranscriptRecords(file) {
  if (!file) return [];
  try {
    return parseLines(fs.readFileSync(file, 'utf8').split('\n'));
  } catch {
    return [];
  }
}

function findTranscriptFile(conversationId, geminiRoot) {
  if (!conversationId || !geminiRoot) return null;
  const hit = antigravitySessionFiles({ root: geminiRoot }).find((r) => r.providerId === conversationId);
  return hit?.file ?? null;
}

function maxStepIndex(records) {
  let max = -1;
  records.forEach((r, i) => {
    const s = Number.isInteger(r?.step_index) ? r.step_index : i;
    if (s > max) max = s;
  });
  return max;
}

function summarizeTranscriptDelta(records, { baselineStep }) {
  const delta = records.filter((r, i) => {
    const s = Number.isInteger(r?.step_index) ? r.step_index : i;
    return s > baselineStep;
  });
  const sawNewUser = delta.some((r) => r?.type === 'USER_INPUT');
  const events = antigravityEvents(delta);
  let lastError = null;
  let tokens = null;
  let hasTerminal = false;
  for (const r of delta) {
    if (r?.type === 'ERROR_MESSAGE') {
      lastError = (typeof r.error === 'string' && r.error) || (typeof r.content === 'string' && r.content.trim()) || 'Antigravity 执行出错';
      hasTerminal = true;
    } else if (r?.type === 'PLANNER_RESPONSE') {
      if (typeof r.input_tokens === 'number' || typeof r.output_tokens === 'number') {
        const prevOut = tokens?.output ?? 0;
        tokens = {
          input: r.input_tokens ?? 0,
          output: prevOut + (r.output_tokens ?? 0),
          cacheRead: r.cache_read_tokens ?? 0,
          cacheWrite: 0,
          thinking: 0,
        };
      }
      if (r.status === 'DONE' && (!Array.isArray(r.tool_calls) || r.tool_calls.length === 0)) {
        hasTerminal = true;
      }
    }
  }
  const eventCount = events.filter((e) => e.role !== 'user' && e.kind !== 'turn_end').length;
  return { delta, sawNewUser, hasTerminal, lastError, tokens, eventCount };
}

function acpModeId(permissionMode) {
  if (permissionMode === 'edits') return 'accept-edits';
  if (permissionMode === 'plan' || permissionMode === 'auto') return permissionMode;
  return null;
}

function acpUsageTokens(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input_tokens: u.inputTokens ?? u.input_tokens ?? 0,
    output_tokens: u.outputTokens ?? u.output_tokens ?? 0,
    cache_read_tokens: u.cachedReadTokens ?? u.cache_read_tokens ?? 0,
    thinking_tokens: u.thoughtTokens ?? u.thinking_tokens ?? 0,
  };
}

/**
 * 通过 `agy acp --stdio --app-data-dir=<product>` 执行或续聊 Desktop / IDE / CLI 会话。
 * 相比 CLI 顶层参数，ACP 原生支持 `--app-data-dir=antigravity` 与桌面会话库无缝互通，
 * 也能在关闭桌面端或用户指定 `plan`/`edits`/`auto`/`bypass`/`effort`/`model` 时完整生效。
 */
export async function runAntigravityAcpTurn({
  member, message, model = null, effort = null, permissionMode = 'default',
  product = 'antigravity', isNew = false, cwd = member?.cwd ?? process.cwd(),
  agyBin = findAgyBinary(), env = process.env, home = undefined,
  onStart, onLine, spawnFn = spawn, timeoutMs = 30 * 60_000,
}) {
  if (!agyBin) {
    return {
      code: 1,
      lines: [],
      stderr: BRIDGE_OR_CLI_MISSING_MSG,
      summary: { status: 'failed', sessionId: member?.providerId ?? null, tokens: null, eventCount: 0, error: BRIDGE_OR_CLI_MISSING_MSG },
    };
  }

  const acpArgs = ['acp', '--stdio', `--app-data-dir=${product}`];
  if (permissionMode === 'bypass') acpArgs.push('--dangerously-skip-permissions');

  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(agyBin);
  const cmd = useShell && /\s/.test(agyBin) ? `"${agyBin}"` : agyBin;
  const child = spawnFn(cmd, acpArgs, {
    cwd,
    env: withAgyEnv(env, home ? { home } : undefined),
    shell: useShell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });

  const lines = [];
  let stderr = '';
  let aborted = false;
  let timedOut = false;
  let sessionId = !isNew ? (member?.providerId ?? null) : null;
  let eventCount = 0;
  let lastUsage = null;
  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const pending = new Map();
  let exited = false;
  let exitInfo = { code: null, error: null };

  const rejectAll = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const sendRaw = (obj) => {
    try {
      child.stdin?.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // 子进程已关闭
    }
  };

  const request = (method, params) => new Promise((resolve, reject) => {
    if (exited) {
      reject(exitInfo.error ?? new Error(`agy acp 已提前退出（code=${exitInfo.code}）`));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    sendRaw({ jsonrpc: '2.0', id, method, params });
  });

  onStart?.({
    kill() {
      aborted = true;
      if (sessionId) sendRaw({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      rejectAll(new Error('已被用户在 Baton 上中止'));
      killChildTree(child);
    },
  });

  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      rejectAll(new Error(`agy acp 执行超时（${timeoutMs}ms）`));
      killChildTree(child);
    }, timeoutMs)
    : null;
  timer?.unref?.();

  let buf = '';
  const handleLine = (line) => {
    lines.push(line);
    onLine?.(line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const h = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) h.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else h.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method === 'session/request_permission') {
      sendRaw({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    if (msg.method === 'session/update') {
      const kind = msg.params?.update?.sessionUpdate;
      if (kind && kind !== 'available_commands_update' && kind !== 'user_message_chunk') eventCount += 1;
      if (msg.params?.update?.usage) lastUsage = acpUsageTokens(msg.params.update.usage);
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c) => {
    if (stderr.length < 256 * 1024) stderr += c;
  });
  child.stdin?.on('error', () => {});
  child.on('error', (err) => {
    exited = true;
    exitInfo = { code: -1, error: err };
    rejectAll(err);
  });
  child.on('close', (code) => {
    exited = true;
    exitInfo = { code, error: null };
    if (buf.trim()) handleLine(buf.trim());
    rejectAll(new Error(stderr.trim().split(/\r?\n/).slice(-2).join(' / ') || `agy acp 退出（code=${code}）`));
  });

  try {
    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'baton', version: '0.2.0' },
    });

    const sessRes = isNew
      ? await request('session/new', { cwd, mcpServers: [] })
      : await request('session/load', { sessionId: member.providerId, cwd, mcpServers: [] });

    sessionId = sessRes?.sessionId ?? sessionId;
    if (sessionId) {
      const startedLine = JSON.stringify({ type: 'conversation.started', conversation_id: sessionId });
      lines.push(startedLine);
      onLine?.(startedLine);
    }

    const modeId = acpModeId(permissionMode);
    if (modeId && sessionId) {
      await request('session/set_mode', { sessionId, modeId });
    }
    if (model && sessionId) {
      await request('session/set_config_option', { sessionId, configId: 'model', value: model }).catch(async () => {
        await request('session/set_model', { sessionId, modelId: model });
      });
    }
    if (effort && sessionId && antigravityModelSupportsEffort(model)) {
      await request('session/set_config_option', { sessionId, configId: 'thought_level', value: effort });
    }

    const promptRes = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: message ?? '' }],
    });
    const tokens = acpUsageTokens(promptRes?.usage) ?? lastUsage;
    const endLine = JSON.stringify({ event: 'result', result: { conversation_id: sessionId, status: 'SUCCESS', usage: tokens } });
    lines.push(endLine);
    onLine?.(endLine);

    return {
      code: 0,
      lines,
      stderr,
      summary: {
        status: 'ok',
        sessionId,
        tokens,
        eventCount: Math.max(eventCount, 1),
        error: null,
      },
    };
  } catch (err) {
    if (aborted) {
      return {
        code: 0,
        lines,
        stderr,
        summary: { status: 'aborted', sessionId, tokens: lastUsage, eventCount, error: '用户已停止这一轮。' },
      };
    }
    const msg = timedOut ? `Antigravity ACP 执行超时（${timeoutMs}ms）` : (err?.message ?? String(err));
    return {
      code: exitInfo.code ?? 1,
      lines,
      stderr: stderr || msg,
      summary: { status: 'failed', sessionId, tokens: lastUsage, eventCount, error: msg },
    };
  } finally {
    clearTimeout(timer);
    try {
      child.stdin?.end();
    } catch {
      // 忽略
    }
    killChildTree(child);
  }
}

/**
 * 执行一轮 Antigravity（三通道按实况自选）：
 * 1. 默认权限下的桌面端（`antigravity/`）优先经官方 `baton-bridge` Sidecar（与桌面 UI 同步）；
 * 2. 桌面端关闭、`antigravity-ide/` 会话、或指定了 `plan`/`edits`/`auto`/`bypass`/`effort`/`model` 时，
 *    经 `agy acp --stdio --app-data-dir=<product>` 无缝续聊或新建会话；
 * 3. `antigravity-cli/` 会话（及测试注入的 `run`）走无头 `agy --input-format=stream-json --output-format=stream-json --print=`。
 */
export async function runAntigravityTurn({
  member, message, model = null, effort = null, permissionMode = 'default', args = null,
  isNew = false, onStart, onLine,
  batonDir = BATON_DIR, geminiRoot = GEMINI_ROOT, geminiConfigDir = DEFAULT_GEMINI_CONFIG,
  env = process.env, run = runProcess, acpRunner = runAntigravityAcpTurn,
  bridgeFinder = findLiveBridge, bridgeCaller = callBridge,
  pollMs = 400, startTimeoutMs = 15_000, maxTurnMs = 30 * 60_000,
}) {
  const product = detectProduct(member);
  const agyBin = findAgyBinary({ env });
  const projectId = member?.cwd
    ? resolveAntigravityProjectId(member.cwd, { geminiConfigDir, createIfMissing: isNew })
    : null;

  const needCliControls = permissionMode !== 'default' || Boolean(effort) || (!isNew && Boolean(model));
  const useBridgeCandidate = product === 'antigravity' && !(agyBin && run === runProcess && needCliControls);
  const bridge = useBridgeCandidate ? await bridgeFinder({ batonDir, projectId }) : null;

  if (bridge) {
    let aborted = false;
    onStart?.({ kill: () => { aborted = true; } });

    const baselineIds = isNew
      ? new Set(antigravityApp({ root: geminiRoot }).summaries.keys())
      : null;
    const baselineStep = isNew ? -1 : maxStepIndex(readTranscriptRecords(member?.file));
    let forwardedStep = baselineStep;

    let conversationId = isNew ? null : member.providerId;
    try {
      if (isNew) {
        const resp = await bridgeCaller(bridge, '/new-conversation', {
          method: 'POST',
          body: { message, ...(model ? { model } : {}), ...(projectId ? { projectId } : {}) },
        });
        conversationId = resp?.conversationId ?? null;
      } else {
        await bridgeCaller(bridge, '/send-message', {
          method: 'POST',
          body: { conversationId, message, ...(projectId ? { projectId } : {}) },
        });
      }
    } catch (err) {
      const msg = `通过 Antigravity 桥接发送失败：${err?.message ?? err}`;
      return {
        code: 1,
        lines: [],
        stderr: msg,
        summary: { status: 'failed', sessionId: conversationId, tokens: null, eventCount: 0, error: msg },
      };
    }

    const startedAt = Date.now();
    if (isNew && !conversationId) {
      while (!aborted && Date.now() - startedAt < startTimeoutMs) {
        const { summaries } = antigravityApp({ root: geminiRoot });
        for (const [id, s] of summaries) {
          if (baselineIds.has(id) || s.nestingDepth > 0 || s.killed) continue;
          if (projectId && s.projectId && s.projectId !== projectId) continue;
          conversationId = id;
          break;
        }
        if (conversationId) break;
        await delay(Math.min(pollMs, 250));
      }
    }

    if (!conversationId) {
      const msg = 'Antigravity 已受理新会话请求，但超时未能取得 conversation_id。';
      return {
        code: 1,
        lines: [],
        stderr: msg,
        summary: { status: 'failed', sessionId: null, tokens: null, eventCount: 0, error: msg },
      };
    }

    onLine?.(JSON.stringify({ type: 'conversation.started', conversation_id: conversationId }));

    let transcriptFile = (!isNew ? member?.file : null) ?? findTranscriptFile(conversationId, geminiRoot);
    let lastDelta = { sawNewUser: false, hasTerminal: false, lastError: null, tokens: null, eventCount: 0 };

    while (!aborted && Date.now() - startedAt < maxTurnMs) {
      transcriptFile ??= findTranscriptFile(conversationId, geminiRoot);
      const records = readTranscriptRecords(transcriptFile);
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const s = Number.isInteger(r?.step_index) ? r.step_index : i;
        if (s > forwardedStep) {
          forwardedStep = s;
          onLine?.(JSON.stringify(r));
        }
      }
      lastDelta = summarizeTranscriptDelta(records, { baselineStep });

      const summaryRow = antigravityApp({ root: geminiRoot }).summaries.get(conversationId);
      const isIdle = summaryRow?.status === 'CASCADE_RUN_STATUS_IDLE';
      const finishedInLog = lastDelta.sawNewUser && lastDelta.hasTerminal;

      if (lastDelta.lastError && (!summaryRow || isIdle)) break;
      if (finishedInLog && (!summaryRow || isIdle)) break;
      if (summaryRow && isIdle && lastDelta.sawNewUser && Date.now() - startedAt > 2000 && lastDelta.eventCount > 0) break;

      await delay(pollMs);
    }

    const lines = [
      JSON.stringify({ type: 'conversation.started', conversation_id: conversationId }),
      JSON.stringify({ type: 'turn.completed', conversation_id: conversationId }),
    ];
    if (aborted) {
      return {
        code: 0,
        lines,
        stderr: '',
        summary: {
          status: 'aborted',
          sessionId: conversationId,
          tokens: lastDelta.tokens,
          eventCount: lastDelta.eventCount,
          error: '用户在 Baton 上停止了这一轮监控（Antigravity 桌面端若仍在运行请切换过去手动中止）。',
        },
      };
    }
    return {
      code: lastDelta.lastError ? 1 : 0,
      lines,
      stderr: lastDelta.lastError ?? '',
      summary: {
        status: lastDelta.lastError ? 'failed' : 'ok',
        sessionId: conversationId,
        tokens: lastDelta.tokens,
        eventCount: lastDelta.eventCount,
        error: lastDelta.lastError,
      },
    };
  }

  if (product !== 'antigravity-cli' && agyBin && run === runProcess && !args) {
    return acpRunner({
      member,
      message,
      model,
      effort,
      permissionMode,
      product,
      isNew,
      cwd: member?.cwd ?? process.cwd(),
      agyBin,
      env,
      onStart,
      onLine,
      timeoutMs: maxTurnMs,
    });
  }

  if (agyBin || run !== runProcess) {
    const finalArgs = args ?? (isNew
      ? buildAntigravityNewArgs({ model, permissionMode, effort })
      : buildAntigravityArgs({ sessionId: member.providerId, model, permissionMode, effort }));
    const usesStreamInput = finalArgs.some((a, i) => (
      String(a).startsWith('--input-format=stream-json')
      || (a === '--input-format' && finalArgs[i + 1] === 'stream-json')
    ));
    const stdinMessage = usesStreamInput
      ? `${JSON.stringify({ event: 'user', message: { role: 'user', content: message ?? '' } })}\n`
      : message;
    const r = await run({
      command: agyBin || 'agy',
      args: finalArgs,
      cwd: member?.cwd ?? process.cwd(),
      message: stdinMessage,
      env: withAgyEnv(env),
      onStart,
      onLine,
    });
    return { ...r, summary: summarizeTurn('antigravity', r.lines, r.stderr) };
  }

  return {
    code: 1,
    lines: [],
    stderr: BRIDGE_OR_CLI_MISSING_MSG,
    summary: {
      status: 'failed',
      sessionId: member?.providerId ?? null,
      tokens: null,
      eventCount: 0,
      error: BRIDGE_OR_CLI_MISSING_MSG,
    },
  };
}
