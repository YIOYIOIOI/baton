import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { antigravityApp, antigravityEvents, extractUserRequest, GEMINI_ROOT } from '../antigravity.js';
import { BATON_DIR } from '../config.js';
import { encodeKey } from '../providers.js';
import { antigravityModelSupportsEffort, buildAntigravityArgs, buildAntigravityNewArgs } from './args.js';
import { agyLaunch, findAgyBinary, withAgyEnv } from './agy.js';
import { runProcess } from './spawn.js';
import { childTree } from './childTree.js';
import { workerIdentity } from '../runtime/processIdentity.js';
import { summarizeTurn } from './adapt.js';
import { acpResponse, ByteLines, MAX_LINE_BYTES, TranscriptCursor } from './antigravityStream.js';
import {
  DEFAULT_GEMINI_CONFIG, callBridge, findLiveBridge, resolveAntigravityProjectId,
} from './antigravityBridge.js';

export { findAgyBinary };

export const BRIDGE_OR_CLI_MISSING_MSG = '未检测到运行中的 Antigravity 桌面桥接服务（baton-bridge），且本机未安装 agy 命令行。'
  + '请确认已打开 Antigravity 桌面端（安装或升级 baton-bridge 后重启一次桌面端即可加载），'
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

const desktopDirectories = ['antigravity', ''];

function findTranscriptFile(conversationId, geminiRoot, directory = null) {
  if (!geminiRoot || typeof conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(conversationId)) return null;
  for (const product of directory === null ? desktopDirectories : [directory]) {
    const logs = path.join(geminiRoot, product, 'brain', conversationId, '.system_generated', 'logs');
    for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const file = path.join(logs, name);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* file not published yet */ }
    }
  }
  return null;
}

function memberDirectory(root, file, id) {
  if (!file || !id || !root) return null;
  return desktopDirectories.find((dir) => {
    const rel = path.relative(path.join(root, dir, 'brain', id), file);
    return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
  }) ?? null;
}

function desktopRows(root, conversationId = null, directory = null) {
  return antigravityApp({ root, directories: directory === null ? desktopDirectories : [directory], conversationId }).byDirectory;
}

function desktopRow(root, id, directory) {
  for (const rows of desktopRows(root, id, directory).values()) {
    if (rows.has(id)) return rows.get(id);
  }
  return null;
}

function matchesDesktopInput(record, prompt) {
  return record.type === 'USER_INPUT' && typeof prompt === 'string'
    && extractUserRequest(record.content, { includeInternal: true }).replaceAll('\r\n', '\n') === prompt.trim().replaceAll('\r\n', '\n');
}

export function desktopWorkspaceIdentity(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  let fd;
  try {
    const real = fs.realpathSync.native(value);
    // On Windows libuv obtains the directory file ID for stat. A conventional open can
    // reject directories there. POSIX can keep an open directory handle through fstat.
    if (process.platform !== 'win32') fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const stat = fd === undefined ? fs.statSync(real, { bigint: true }) : fs.fstatSync(fd, { bigint: true });
    if (!stat.isDirectory()) return null;
    const hasId = stat.dev !== 0n && stat.ino !== 0n;
    return { path: real, dev: hasId ? String(stat.dev) : null, ino: hasId ? String(stat.ino) : null };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Older receipts have only the submitted pathname. Accept system spelling differences,
// but never follow a movable workspace link as evidence for an old receipt.
function matchesLegacyWorkspace(requested, physical) {
  const absolute = path.resolve(requested);
  if (absolute === physical) return true;
  if (process.platform === 'darwin') {
    return /^\/(?:var|tmp|etc)(?:\/|$)/.test(absolute) && '/private' + absolute === physical;
  }
  if (process.platform !== 'win32' || path.parse(absolute).root.toLowerCase() !== path.parse(physical).root.toLowerCase()) return false;
  // On NTFS, a long name and its 8.3 alias describe the same directory entry.
  // A junction or directory symlink is a different entry whose target can change.
  try {
    for (let entry = absolute; entry !== path.dirname(entry); entry = path.dirname(entry)) {
      if (!fs.lstatSync(entry).isDirectory()) return false;
    }
    return true;
  } catch { return false; }
}

export function sameDesktopWorkspace(requested, hosted, pinned = null) {
  const target = desktopWorkspaceIdentity(requested);
  const actual = desktopWorkspaceIdentity(hosted);
  const matches = (a, b) => a.dev && a.ino && b.dev && b.ino
    ? a.dev === b.dev && a.ino === b.ino : a.path === b.path;
  return !!(target && actual && matches(target, actual)
    && (pinned ? matches(pinned, target) : matchesLegacyWorkspace(requested, target.path)));
}

export function createdConversationObserver({ baseline, projectId, cwd, workspace = null, claimedId = null }, message, root = GEMINI_ROOT, mayClaim = (_match) => true) {
  const prior = new Map(baseline.map(([directory, ids]) => [directory, new Set(ids)]));
  const candidates = new Map();
  return () => {
    const summaries = desktopRows(root, claimedId);
    const matches = [];
    let hasBacklog = false;
    for (const directory of desktopDirectories) {
      const rows = summaries.get(directory);
      const ids = claimedId ? [claimedId] : rows?.keys() ?? [];
      for (const id of ids) {
        const row = rows?.get(id);
        if (prior.get(directory)?.has(id) || row?.nestingDepth > 0 || !sameDesktopWorkspace(cwd, row?.cwd, workspace)
          || (projectId && row.projectId && row.projectId !== projectId)) continue;
        const file = findTranscriptFile(id, root, directory);
        if (!file) continue;
        const key = directory + '/' + id;
        const previous = candidates.get(key);
        const candidate = previous?.file === file ? previous : { file, cursor: new TranscriptCursor(), matches: null };
        candidates.set(key, candidate);
        if (candidate.cursor) {
          const caughtUp = candidate.cursor.read(file, (r) => {
            if (candidate.matches === null && r.type === 'USER_INPUT') candidate.matches = matchesDesktopInput(r, message);
          });
          if (candidate.matches !== null) candidate.cursor = null;
          else if (!caughtUp) hasBacklog = true;
        }
        if (candidate.matches) {
          const match = { id, directory, projectId: row.projectId, cwd: row.cwd, key: encodeKey('antigravity', path.relative(root, file).split(path.sep).join('/')) };
          if (mayClaim(match)) matches.push(match);
        }
      }
    }
    return { match: !hasBacklog && matches.length === 1 ? matches[0] : null, hasBacklog };
  };
}

async function locateCreatedConversation(observe, pollMs, startTimeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const { match, hasBacklog } = observe();
    if (match) return match;
    if (hasBacklog) await yieldIO();
    else await delay(Date.now() - startedAt < startTimeoutMs ? Math.min(pollMs, 250) : Math.max(5000, pollMs));
  }
}

function addTranscriptRecord(delta, record) {
  if (record.type === 'USER_INPUT') delta.sawNewUser = true;
  delta.eventCount += antigravityEvents([record]).filter((event) => event.role !== 'user' && event.kind !== 'turn_end').length;
  if (record.type === 'ERROR_MESSAGE') {
    delta.lastError = (typeof record.error === 'string' && record.error)
      || (typeof record.content === 'string' && record.content.trim()) || 'Antigravity 执行出错';
    delta.hasTerminal = true;
  } else if (record.type === 'PLANNER_RESPONSE') {
    if (typeof record.input_tokens === 'number' || typeof record.output_tokens === 'number') {
      delta.tokens = {
        input: record.input_tokens ?? 0, output: (delta.tokens?.output ?? 0) + (record.output_tokens ?? 0),
        cacheRead: record.cache_read_tokens ?? 0, cacheWrite: 0, thinking: 0,
      };
    }
    if (record.status === 'DONE' && (!Array.isArray(record.tool_calls) || record.tool_calls.length === 0)) {
      delta.hasTerminal = true;
    }
  }
}

/** Resume observation of a desktop-owned turn without resubmitting or cancelling it. */
export function desktopRecovery(repo, { geminiRoot = GEMINI_ROOT, onCheckpoint = (_turn, _monitor) => {} } = {}) {
  const pending = new Map();
  return (turn) => {
    const unconfirmed = () => ({ status: 'unconfirmed', tokens: null, eventCount: 0,
      error: 'Baton 重启期间桌面的两轮执行可能交错，本轮结果待确认。请在 Antigravity 桌面核对。自动队列已暂停，核对后可手动立即发送下一条。' });
    // The transcript may be empty or between rotations at startup. The saved phase alone
    // proves there was an unresolved boundary when this daemon lost observation.
    if (!pending.has(turn.turnId) && (turn.monitor?.awaitingIdle === true || turn.monitor?.awaitingRun === true)) return unconfirmed();
    const member = repo.getSession(turn.key);
    const id = turn.monitor?.conversationId ?? member?.providerId;
    if (!id) return null;
    let state = pending.get(turn.turnId);
    if (!state) {
      const cursor = new TranscriptCursor();
      const anchored = Number.isInteger(turn.monitor?.userStep) && turn.monitor.userStep > (turn.monitor.baselineStep ?? -1);
      cursor.highest = Math.max(anchored ? turn.monitor.userStep : (turn.monitor?.baselineStep ?? -1), turn.monitor?.ignoreThrough ?? -1);
      const directory = desktopDirectories.includes(turn.monitor?.directory)
        ? turn.monitor.directory : memberDirectory(geminiRoot, member?.file, id);
      const awaitingIdle = turn.monitor?.awaitingIdle ?? !anchored;
      const awaitingRun = turn.monitor?.awaitingRun === true;
      state = { cursor, directory, userStep: anchored ? turn.monitor.userStep : null, sawSummary: false,
        sawRunning: anchored && !awaitingIdle && !awaitingRun && turn.monitor?.sawRunning === true,
        coldBoundary: awaitingIdle || awaitingRun, awaitingIdle, awaitingRun,
        ignoreThrough: turn.monitor?.ignoreThrough ?? -1, checkpoint: turn.monitor ?? {},
        delta: { sawNewUser: anchored, hasTerminal: false, lastError: null, tokens: null, eventCount: 0 } };
      pending.set(turn.turnId, state);
    }
    const file = state.directory === null ? member?.file ?? findTranscriptFile(id, geminiRoot)
      : findTranscriptFile(id, geminiRoot, state.directory);
    const row = desktopRow(geminiRoot, id, state.directory);
    if (state.awaitingRun && row?.status === 'CASCADE_RUN_STATUS_RUNNING') state.awaitingRun = false;
    const caughtUp = state.cursor.read(file, (record) => {
      if (state.userStep === null) {
        if (!matchesDesktopInput(record, turn.prompt)
          || (!Number.isInteger(turn.monitor?.baselineStep) && !(Date.parse(record.created_at) >= turn.startedAt))) return;
        state.userStep = state.cursor.highest;
      } else if (state.awaitingIdle || state.awaitingRun) return;
      addTranscriptRecord(state.delta, record);
    });
    // Status is a snapshot. While Baton was down either turn could have written these steps,
    // including a complete RUNNING → IDLE cycle. An owned USER_INPUT alone cannot assign them.
    if (state.coldBoundary && state.userStep !== null && !row?.killed) {
      pending.delete(turn.turnId);
      return unconfirmed();
    }
    if (caughtUp) state.coldBoundary = false;
    if (row) state.sawSummary = true;
    const idle = row?.status === 'CASCADE_RUN_STATUS_IDLE';
    if (state.awaitingIdle || state.awaitingRun) state.ignoreThrough = Math.max(state.ignoreThrough, state.cursor.highest);
    if (caughtUp && idle && state.awaitingIdle) {
      state.awaitingIdle = false;
      state.awaitingRun = state.userStep !== null;
    }
    const eligible = state.userStep !== null && !state.awaitingIdle && !state.awaitingRun;
    if (eligible && row?.status === 'CASCADE_RUN_STATUS_RUNNING') state.sawRunning = true;
    if (!row?.killed && (!eligible || !caughtUp || !((state.sawRunning && idle) || (state.delta.hasTerminal && (idle || !state.sawSummary))))) {
      const progress = { userStep: state.userStep, ignoreThrough: state.ignoreThrough, sawRunning: state.sawRunning,
        awaitingIdle: state.awaitingIdle, awaitingRun: state.awaitingRun };
      if (Object.entries(progress).some(([k, value]) => state.checkpoint[k] !== value)) {
        const monitor = { ...state.checkpoint, ...progress, conversationId: id, directory: state.directory };
        onCheckpoint(turn, monitor);
        state.checkpoint = monitor;
      }
      return null;
    }
    pending.delete(turn.turnId);
    const error = row?.killed ? '桌面端已经关闭了这个会话。' : state.delta.lastError;
    return { status: error ? 'failed' : 'ok', error: error ?? null, tokens: state.delta.tokens, eventCount: state.delta.eventCount };
  };
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
  agyBin = undefined, env = process.env, home = undefined,
  onStart, onLine, spawnFn = spawn, timeoutMs = 30 * 60_000,
  maxLineBytes = MAX_LINE_BYTES, maxRetainedBytes = 1024 * 1024,
}) {
  const launch = agyLaunch({ agyBin, cwd, env, home });
  if (!launch) {
    return {
      code: 1,
      lines: [],
      stderr: BRIDGE_OR_CLI_MISSING_MSG,
      summary: { status: 'failed', sessionId: member?.providerId ?? null, tokens: null, eventCount: 0, error: BRIDGE_OR_CLI_MISSING_MSG },
    };
  }

  const acpArgs = ['acp', '--stdio', `--app-data-dir=${product}`];
  if (permissionMode === 'bypass') acpArgs.push('--dangerously-skip-permissions');

  const child = spawnFn(launch.command, acpArgs, {
    cwd,
    env: launch.env, shell: launch.shell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });

  const retained = [];
  let firstLine = 0;
  let retainedBytes = 0;
  const emit = (line) => {
    onLine?.(line);
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > maxRetainedBytes) return;
    retained.push({ line, bytes });
    retainedBytes += bytes;
    while (retainedBytes > maxRetainedBytes || retained.length - firstLine > 4096) {
      retainedBytes -= retained[firstLine].bytes;
      retained[firstLine++] = null;
    }
    if (firstLine >= 1024) {
      retained.splice(0, firstLine);
      firstLine = 0;
    }
  };
  const retainedLines = () => retained.slice(firstLine).map((entry) => entry.line);
  let stderr = '';
  const stderrDecoder = new StringDecoder('utf8');
  let stderrBytes = 0;
  let protocolError = null;
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
  const closed = new Promise((resolve) => child.once('close', resolve));
  const tree = childTree(child);
  const identity = workerIdentity();
  const terminate = () => tree.stop();

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
    if (protocolError) return reject(protocolError);
    if (exited) {
      reject(exitInfo.error ?? new Error(`agy acp 已提前退出（code=${exitInfo.code}）`));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    sendRaw({ jsonrpc: '2.0', id, method, params });
  });

  onStart?.({
    pid: child.pid,
    detachedGroup: process.platform !== 'win32',
    onPid: identity.observe,
    kill() {
      aborted = true;
      if (sessionId) sendRaw({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      rejectAll(new Error('已被用户在 Baton 上中止'));
      terminate();
    },
  });

  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      rejectAll(new Error(`agy acp 执行超时（${timeoutMs}ms）`));
      terminate();
    }, timeoutMs)
    : null;
  timer?.unref?.();

  const frames = new ByteLines(maxLineBytes);
  const handleLine = (line) => {
    if (protocolError || !line.trim()) return;
    emit(line);
    const msg = acpResponse(line, sendRaw, (update) => {
      const kind = update?.sessionUpdate;
      if (kind && kind !== 'available_commands_update' && kind !== 'user_message_chunk') eventCount += 1;
      if (update?.usage) lastUsage = acpUsageTokens(update.usage);
    });
    if (msg && pending.has(msg.id)) {
      const h = pending.get(msg.id);
      pending.delete(msg.id);
      if (Object.hasOwn(msg, 'error')) h.reject(new Error(msg.error?.message || JSON.stringify(msg.error)));
      else h.resolve(msg.result);
    }
  };

  child.stdout?.on('data', (chunk) => {
    if (protocolError) return;
    frames.push(chunk, handleLine, () => {
      protocolError = new Error('Antigravity ACP 单条消息超过 ' + maxLineBytes + ' 字节');
      rejectAll(protocolError);
      terminate();
    });
  });
  child.stderr?.on('data', (chunk) => {
    const count = Math.min(chunk.length, 256 * 1024 - stderrBytes);
    if (count > 0) {
      stderr += stderrDecoder.write(chunk.subarray(0, count));
      stderrBytes += count;
    }
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
    if (frames.size) handleLine(frames.text());
    rejectAll(new Error(stderr.trim().split(/\r?\n/).slice(-2).join(' / ') || `agy acp 退出（code=${code}）`));
  });

  try {
    if (onStart) await identity.bind(child);
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
      emit(startedLine);
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
    emit(endLine);

    return {
      code: 0,
      lines: retainedLines(),
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
        lines: retainedLines(),
        stderr,
        summary: { status: 'aborted', sessionId, tokens: lastUsage, eventCount, error: '用户已停止这一轮。' },
      };
    }
    const msg = timedOut ? `Antigravity ACP 执行超时（${timeoutMs}ms）` : (err?.message ?? String(err));
    return {
      code: exitInfo.code ?? 1,
      lines: retainedLines(),
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
    terminate();
    await closed;
    await tree.wait();
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
  isNew = false, onStart, onLine, mayClaimCreation = undefined,
  batonDir = BATON_DIR, geminiRoot = GEMINI_ROOT, geminiConfigDir = DEFAULT_GEMINI_CONFIG,
  env = process.env, agyBin = undefined, run = runProcess, acpRunner = runAntigravityAcpTurn,
  bridgeFinder = findLiveBridge, bridgeCaller = callBridge,
  pollMs = 400, startTimeoutMs = 15_000, maxTurnMs = 30 * 60_000,
}) {
  // 查找桥接实例期间消息尚未发出，这时仍可以取消。
  let cancelledBeforeDispatch = false;
  onStart?.({ kill() { cancelledBeforeDispatch = true; } });
  const product = detectProduct(member);
  // 桥接只支持新建时选模型；已有会话的模型、权限和强度需要 CLI 执行。
  const needCliControls = permissionMode !== 'default' || Boolean(effort) || (!isNew && Boolean(model));
  const useBridgeCandidate = product === 'antigravity' && !needCliControls;
  const projectId = useBridgeCandidate && member?.cwd
    ? resolveAntigravityProjectId(member.cwd, { geminiConfigDir, createIfMissing: isNew })
    : null;
  const bridge = useBridgeCandidate ? await bridgeFinder({ batonDir, projectId }) : null;
  let directory = !isNew && bridge ? memberDirectory(geminiRoot, member?.file, member.providerId) : null;
  const baselineFile = bridge && !isNew ? (directory === null ? member?.file : findTranscriptFile(member.providerId, geminiRoot, directory))
    ?? member?.file ?? findTranscriptFile(member.providerId, geminiRoot) : null;
  const transcript = bridge ? new TranscriptCursor() : null;
  if (baselineFile && !cancelledBeforeDispatch) await transcript.skipExisting(baselineFile);
  if (cancelledBeforeDispatch) {
    return {
      code: null, lines: [], stderr: '',
      summary: { status: 'aborted', sessionId: isNew ? null : member.providerId, tokens: null, eventCount: 0, error: '已在发给 Antigravity 前停止。' },
    };
  }

  if (bridge) {
    const workspace = isNew ? desktopWorkspaceIdentity(member?.cwd) : null;
    if (isNew && !workspace) {
      const error = '无法确认新建会话的工作目录，消息尚未发出。';
      return { code: 1, lines: [], stderr: error, summary: { status: 'failed', sessionId: null, tokens: null, eventCount: 0, error, delivery: 'not_dispatched' } };
    }
    let creation = isNew ? {
      baseline: [...desktopRows(geminiRoot)].map(([dir, rows]) => [dir, [...rows.keys()]]),
      projectId, cwd: workspace.path, workspace, claimedId: null, delivery: 'pending',
    } : null;

    let conversationId = isNew ? null : member.providerId;
    const baselineStep = transcript.highest;
    let userStep = null;
    let awaitingIdle = !isNew && desktopRow(geminiRoot, conversationId, directory)?.status === 'CASCADE_RUN_STATUS_RUNNING';
    let awaitingRun = false;
    let ignoreThrough = -1;
    const reportMonitor = (sawRunning = false) => onStart?.({
      canStop: false, monitor: { conversationId, directory, baselineStep, userStep, sawRunning, awaitingIdle, awaitingRun, ignoreThrough },
      ...(creation ? { creation } : {}),
    });
    reportMonitor();
    try {
      if (isNew) {
        const resp = await bridgeCaller(bridge, '/new-conversation', {
          method: 'POST',
          body: { message, ...(model ? { model } : {}), ...(projectId ? { projectId } : {}) },
        });
        const claimed = resp?.conversationId;
        conversationId = typeof claimed === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claimed) ? claimed : null;
        creation = { ...creation, claimedId: conversationId, delivery: 'accepted' };
      } else {
        await bridgeCaller(bridge, '/send-message', {
          method: 'POST',
          body: { conversationId, message, ...(projectId ? { projectId } : {}) },
        });
      }
    } catch (err) {
      if (!err?.deliveryUnknown) {
        const msg = `通过 Antigravity 桥接发送失败：${err?.message ?? err}`;
        return {
          code: 1, lines: [], stderr: msg,
          summary: { status: 'failed', sessionId: conversationId, tokens: null, eventCount: 0, error: msg, delivery: 'not_dispatched' },
        };
      }
      // 请求已写出但回执丢了。桌面可能已经执行，沿用本次消息继续观察。
      if (creation) creation = { ...creation, delivery: 'unknown' };
    }

    const startedAt = Date.now();
    if (isNew) {
      reportMonitor();
      const created = await locateCreatedConversation(createdConversationObserver(creation, message, geminiRoot, mayClaimCreation), pollMs, startTimeoutMs);
      conversationId = created.id;
      directory = created.directory;
      creation = null;
      reportMonitor();
      onLine?.(JSON.stringify({ type: 'conversation.started', conversation_id: conversationId, key: created.key, directory, projectId: created.projectId }));
    }

    if (!conversationId) {
      const msg = '无法取得要继续的 Antigravity 会话标识。';
      return {
        code: 1,
        lines: [],
        stderr: msg,
        summary: { status: 'failed', sessionId: null, tokens: null, eventCount: 0, error: msg },
      };
    }

    if (!isNew) onLine?.(JSON.stringify({ type: 'conversation.started', conversation_id: conversationId }));

    const lastDelta = { sawNewUser: false, hasTerminal: false, lastError: null, tokens: null, eventCount: 0 };
    let sawSummary = false;
    let sawRunning = false;

    for (;;) {
      const file = directory === null && baselineFile ? baselineFile : findTranscriptFile(conversationId, geminiRoot, directory) ?? baselineFile;
      const summaryRow = desktopRow(geminiRoot, conversationId, directory);
      if (awaitingRun && summaryRow?.status === 'CASCADE_RUN_STATUS_RUNNING') {
        awaitingRun = false;
        reportMonitor(sawRunning);
      }
      const caughtUp = transcript.read(file, (record, line) => {
        if (userStep === null) {
          if (!matchesDesktopInput(record, message)) return;
          userStep = transcript.highest;
          reportMonitor();
        } else if (awaitingIdle || awaitingRun) return;
        onLine?.(line);
        addTranscriptRecord(lastDelta, record);
      });

      if (summaryRow?.killed) {
        lastDelta.lastError = '桌面端已经关闭了这个会话。';
        break;
      }
      if (summaryRow) sawSummary = true;
      const isIdle = summaryRow?.status === 'CASCADE_RUN_STATUS_IDLE';
      if (awaitingIdle || awaitingRun) {
        const caughtPriorIdle = caughtUp && awaitingIdle && isIdle;
        if (caughtPriorIdle || transcript.highest > ignoreThrough) {
          if (caughtPriorIdle) {
            awaitingIdle = false;
            awaitingRun = userStep !== null;
          }
          ignoreThrough = Math.max(ignoreThrough, transcript.highest);
          reportMonitor(sawRunning);
        }
      }
      if (!awaitingIdle && !awaitingRun && !sawRunning && lastDelta.sawNewUser && summaryRow?.status === 'CASCADE_RUN_STATUS_RUNNING') {
        sawRunning = true;
        reportMonitor(true);
      }
      const finishedInLog = lastDelta.sawNewUser && lastDelta.hasTerminal;

      if (!caughtUp) {
        await yieldIO();
        continue;
      }
      if ((lastDelta.lastError || finishedInLog) && (!sawSummary || isIdle)) break;
      if (sawRunning && isIdle) break;

      // 桌面执行由宿主持有。等待超时只能降低轮询频率，不能据此释放队列。
      await delay(Date.now() - startedAt < maxTurnMs ? pollMs : Math.max(5000, pollMs));
    }

    const lines = [
      JSON.stringify({ type: 'conversation.started', conversation_id: conversationId }),
      JSON.stringify({ type: 'turn.completed', conversation_id: conversationId }),
    ];
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

  const cwd = member?.cwd ?? process.cwd();
  const runtime = run === runProcess ? agyLaunch({ agyBin, cwd, env }) : null;
  if (product !== 'antigravity-cli' && runtime && !args) {
    return acpRunner({
      member,
      message,
      model,
      effort,
      permissionMode,
      product,
      isNew,
      cwd, agyBin: runtime.file, env: runtime.env,
      onStart,
      onLine,
      timeoutMs: maxTurnMs,
    });
  }

  if (runtime || run !== runProcess) {
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
      command: runtime?.file || agyBin || 'agy',
      runtime,
      args: finalArgs,
      cwd,
      message: stdinMessage,
      env: runtime?.env ?? withAgyEnv(env),
      onStart,
      onLine,
    });
    return { ...r, summary: summarizeTurn('antigravity', r.lines, r.stderr) };
  }

  const error = needCliControls
    ? '要使用本轮选定的权限、模型或思考强度，需要安装 agy CLI。安装后请从 Baton 重发。'
    : BRIDGE_OR_CLI_MISSING_MSG;
  return {
    code: 1,
    lines: [],
    stderr: error,
    summary: {
      status: 'failed',
      sessionId: member?.providerId ?? null,
      tokens: null,
      eventCount: 0,
      error,
    },
  };
}
