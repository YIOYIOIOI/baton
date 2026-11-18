// 把两个 CLI 的 stdout 归一成轮次终态。字段名全部来自实测，
// 依据与三个陷阱见 docs/ops/agent-protocol.md —— 不要凭猜改这里。

function parse(lines) {
  const out = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      // codex 会往 stdout/stderr 混入非 JSON 噪声（例如技能加载失败），跳过
    }
  }
  return out;
}

const NO_TERMINAL = '进程输出里没有任何终态记录。这属于异常而非成功——'
  + '检查 agent 是否被中途杀掉，或输出 schema 已变（见 docs/ops/agent-protocol.md）。';

/**
 * codex 0.164 起每个会话有一把「写入锁」（~/.codex/thread-writer-locks/<thread>.lock）。
 * Codex App 开着这个会话时锁在 App 手里，`codex exec resume` 拿不到就当场退出，stdout 一条记录都没有
 * （见 agent-protocol §14）。消息根本没进会话——要把这件事说成人话，并给出能照做的一步。
 *
 * **认的是真实的报错原文**（2026-11-09 拿真的 `codex exec resume` 撞那把锁抓到的）：
 *
 *   ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict:
 *     thread 01a1a01d-… already has an active writer
 *   Error: thread/resume: thread/resume failed: thread 01a1a01d-… already has an active writer (code -32600)
 *
 * 第一版只认 `thread writer lock`——未能命中 `codex exec resume` 实际在 stderr
 * 输出的 `already has an active writer` / `thread-store conflict`，测试与线上脱节。两句都认。
 */
const WRITER_LOCK = /thread writer lock|already has an active writer|thread-store conflict/i;
const WRITER_LOCK_MSG = '这条消息没有发出去：这个会话正在 Codex App 里开着，App 占着它的写入锁，'
  + 'Baton 这边写不进去。在 Codex App 里切到别的会话、或者关掉 App 之后再发；也可以直接在 App 里接着聊。';

/**
 * 进程在吐出任何 JSON 之前就退出了：真正的原因只在 stderr 里。
 *
 * 原来只读 stdout，于是界面上永远是那句「没有任何终态记录」，人完全不知道发生了什么。
 * 取最后几行有内容的，去掉已知的噪声（codex 的「Reading prompt from stdin...」、Node 的弃用警告）。
 */
export function stderrReason(stderr) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Reading prompt from stdin/i.test(l) && !/DeprecationWarning|--trace-deprecation/.test(l));
  if (!lines.length) return null;
  if (lines.some((l) => WRITER_LOCK.test(l))) return WRITER_LOCK_MSG;
  return lines.slice(-3).join(' / ').slice(0, 600);
}

// Claude：result 记录是终态。
// 陷阱：失败时 subtype 仍是 'success'，只有 is_error 说了实话。
function summarizeClaude(records, stderr) {
  let sessionId = null;
  let terminal = null;
  let eventCount = 0;
  for (const r of records) {
    if (r.session_id) sessionId = r.session_id;
    // 消息计数：agent 到底有没有产出内容。零消息 + 有 token = 异常（spec §12）
    if (r.type === 'assistant') eventCount += 1;
    if (r.type === 'result') terminal = r;
  }
  if (!terminal) return { status: 'failed', sessionId, tokens: null, eventCount, error: stderrReason(stderr) ?? NO_TERMINAL };
  if (terminal.is_error === true) {
    return {
      status: 'failed',
      sessionId: terminal.session_id ?? sessionId,
      tokens: terminal.usage ?? null,
      eventCount,
      error: typeof terminal.result === 'string' ? terminal.result : '未给出错误信息',
    };
  }
  return {
    status: 'ok',
    sessionId: terminal.session_id ?? sessionId,
    tokens: terminal.usage ?? null,
    eventCount,
    error: null,
  };
}

// Codex：stdout 用点号扁平结构，与它自己的 rollout 文件 schema 完全不同。
// 陷阱：成功的一轮里也会出现 error 记录（瞬时重连通知），
// 所以终态只看 turn.completed 是否出现，绝不拿 error 判失败。
function summarizeCodex(records, stderr) {
  let sessionId = null;
  let completed = null;
  let lastError = null;
  let eventCount = 0;
  for (const r of records) {
    if (r.type === 'thread.started' && r.thread_id) sessionId = r.thread_id;
    if (r.type === 'error' && typeof r.message === 'string') lastError = r.message;
    if (r.type === 'item.completed') eventCount += 1;
    if (r.type === 'turn.completed') completed = r;
  }
  if (completed) {
    return { status: 'ok', sessionId, tokens: completed.usage ?? null, eventCount, error: null };
  }
  return {
    status: 'failed',
    sessionId,
    tokens: null,
    eventCount,
    error: lastError ?? stderrReason(stderr) ?? NO_TERMINAL,
    // 拿不到写入锁：调用方据此改走「交给 Codex App 排队」（agent/codexQueue.js）
    lockHeld: !lastError && eventCount === 0 && WRITER_LOCK.test(String(stderr ?? '')),
  };
}

function summarizeAntigravity(records, rawLines, stderr) {
  let sessionId = null;
  let completed = false;
  let lastError = null;
  let tokens = null;
  let eventCount = 0;
  for (const r of records) {
    // 实测 `agy.exe --output-format=stream-json` 输出形状：{ event: 'init'|'step_update'|'result', ... }
    if (r.event === 'init') {
      const cid = r.conversation_id ?? r.init?.conversation_id;
      if (typeof cid === 'string' && cid) sessionId = cid;
    } else if (r.event === 'step_update' && r.step_update && typeof r.step_update === 'object') {
      const su = r.step_update;
      if (typeof su.conversation_id === 'string' && su.conversation_id) sessionId = su.conversation_id;
      if (su.state === 'DONE' && su.step_type && su.step_type !== 'user_input') eventCount += 1;
      if (su.usage && typeof su.usage === 'object') tokens = su.usage;
    } else if (r.event === 'result' && r.result && typeof r.result === 'object') {
      const res = r.result;
      completed = true;
      if (typeof res.conversation_id === 'string' && res.conversation_id) sessionId = res.conversation_id;
      if (res.usage && typeof res.usage === 'object') tokens = res.usage;
      if (res.status === 'ERROR' || (typeof res.error === 'string' && res.error)) {
        lastError = (typeof res.error === 'string' && res.error)
          || (typeof res.response === 'string' && res.response.trim())
          || 'Antigravity 执行出错';
      }
    }

    const cid = r.conversation_id ?? r.conversationId ?? r.session_id;
    if (typeof cid === 'string' && cid) sessionId = cid;
    if (r.type === 'conversation.started' && r.conversation_id) sessionId = r.conversation_id;
    if (r.type === 'error' && typeof r.message === 'string') lastError = r.message;
    if (r.type === 'result' && r.is_error === true) lastError = typeof r.result === 'string' ? r.result : 'Antigravity 执行出错';
    if (r.type === 'turn.completed' || r.type === 'result') completed = true;
    if (r.type === 'assistant' || r.type === 'PLANNER_RESPONSE' || r.type === 'message' || r.type === 'text') eventCount += 1;
    if (r.usage && typeof r.usage === 'object') tokens = r.usage;
  }
  if (lastError) return { status: 'failed', sessionId, tokens, eventCount, error: lastError };
  if (completed || eventCount > 0) return { status: 'ok', sessionId, tokens, eventCount: Math.max(eventCount, 1), error: null };
  // `--output-format text` 纯文本回退
  const plain = rawLines.map((l) => String(l ?? '').trim()).filter(Boolean);
  if (plain.length && !stderrReason(stderr)) {
    return { status: 'ok', sessionId, tokens: null, eventCount: plain.length, error: null };
  }
  return {
    status: 'failed',
    sessionId,
    tokens: null,
    eventCount,
    error: stderrReason(stderr) ?? NO_TERMINAL,
  };
}

/** `stderr`：进程的标准错误。只在 stdout 里找不到终态与错误记录时才拿来解释失败 */
export function summarizeTurn(agent, lines, stderr = '') {
  const records = parse(lines);
  if (agent === 'claude') return summarizeClaude(records, stderr);
  if (agent === 'antigravity') return summarizeAntigravity(records, lines, stderr);
  return summarizeCodex(records, stderr);
}
