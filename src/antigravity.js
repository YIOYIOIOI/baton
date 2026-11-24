import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEvent } from './events.js';

export const GEMINI_ROOT = path.join(os.homedir(), '.gemini');
export const ANTIGRAVITY_PRODUCTS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function parseTimeMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return 0;
  // SQLite 里存的是 `2026-11-17 09:51:32.316125+00:00`，空格换成 T 兼容 Date.parse
  const ms = Date.parse(v.trim().replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : 0;
}

function decodeWorkspaceUri(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      list = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const first = Array.isArray(list) ? list.find((u) => typeof u === 'string' && u.trim()) : null;
  if (!first) return null;
  if (first.startsWith('file://')) {
    try {
      const p = fileURLToPath(first);
      // Windows URL file:///c%3A/... → c:\...
      return p;
    } catch {
      return null;
    }
  }
  return path.isAbsolute(first) ? first : null;
}

/**
 * @typedef {{
 *   title: string | null,
 *   cwd: string | null,
 *   projectId: string | null,
 *   status: string | null,
 *   notFullyIdle: boolean,
 *   nestingDepth: number,
 *   killed: boolean,
 *   parentId: string | null,
 *   lastModifiedTime: string | null,
 *   lastModifiedMs: number,
 *   product: string,
 * }} AntigravitySummary
 */

/**
 * 读 Antigravity 的会话摘要库 `<product>/conversation_summaries.db`。
 *
 * 只读打开（`open: true, readOnly: true`），避免干扰桌面端 WAL 写入；
 * 库不存在或暂时打不开时安静返回空表，不影响其余会话与单测。
 *
 * @param {{ root?: string, directories?: string[], conversationId?: string | null }} [opts]
 * @returns {{ summaries: Map<string, AntigravitySummary>, byDirectory: Map<string, Map<string, AntigravitySummary>> }}
 */
export function antigravityApp({ root = GEMINI_ROOT, directories = ['', ...ANTIGRAVITY_PRODUCTS], conversationId = null } = {}) {
  /** @type {Map<string, AntigravitySummary>} */
  const summaries = new Map();
  const byDirectory = new Map();
  if (!root) return { summaries, byDirectory };

  for (const directory of directories) {
    const resolved = path.resolve(root, directory, 'conversation_summaries.db');
    if (!fs.existsSync(resolved)) continue;

    let db;
    try {
      db = new DatabaseSync(resolved, { open: true, readOnly: true });
      const query = `
        SELECT conversation_id, title, workspace_uris, project_id, status,
               not_fully_idle, nesting_depth, killed, parent_conversation_id, last_modified_time
        FROM conversation_summaries
      `;
      const rows = conversationId === null
        ? db.prepare(query).all()
        : db.prepare(query + ' WHERE conversation_id = ?').all(conversationId);

      const local = new Map();
      byDirectory.set(directory, local);
      for (const row of rows) {
        const id = text(row?.conversation_id);
        if (!id) continue;
        const mMs = parseTimeMs(row.last_modified_time);
        const parentRaw = text(row.parent_conversation_id);
        const summary = {
          title: text(row.title),
          cwd: decodeWorkspaceUri(row.workspace_uris),
          projectId: text(row.project_id),
          status: text(row.status),
          notFullyIdle: Boolean(row.not_fully_idle),
          nestingDepth: Number(row.nesting_depth ?? 0),
          killed: Boolean(row.killed),
          parentId: parentRaw && parentRaw !== id ? parentRaw : null,
          lastModifiedTime: text(row.last_modified_time),
          lastModifiedMs: mMs,
          product: directory || 'antigravity',
        };
        local.set(id, summary);
        if (!summaries.has(id) || summaries.get(id).lastModifiedMs <= mMs) summaries.set(id, summary);
      }
    } catch {
      // 库不存在、结构不兼容或损坏，跳过
    } finally {
      try {
        db?.close();
      } catch {
        // 忽略关闭异常
      }
    }
  }
  return { summaries, byDirectory };
}

/**
 * 从 Antigravity 的 `USER_INPUT.content` 剥出真实用户消息。
 * 宿主常把请求包在 `<USER_REQUEST>...</USER_REQUEST>` 里，后跟 `<ADDITIONAL_METADATA>`
 * 与 `<USER_SETTINGS_CHANGE>`。
 */
export function extractUserRequest(rawContent, { includeInternal = false } = {}) {
  const s = String(rawContent ?? '');
  const m = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/.exec(s);
  const body = (
    m
      ? m[1]
      : s
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
  ).trim();
  if (!includeInternal && (body.startsWith('<CONTEXT_SUMMARY>') || body.startsWith('<baton_goal_continue>'))) return '';
  return body;
}

/** 从 `<USER_SETTINGS_CHANGE>` 里提取切换后的模型显示名。 */
export function extractSettingsModel(rawContent) {
  const s = String(rawContent ?? '');
  const block = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/.exec(s)?.[1] ?? '';
  if (!block) return null;
  const m = /`?Model Selection`?\s+from\s+.+?\s+to\s+([^.\r\n<]+)/i.exec(block);
  return m ? m[1].trim() : null;
}

/** 紧凑版 `transcript.jsonl` 的 tool args 字符串值带额外 JSON 引号，这里统一还原。 */
export function normalizeToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args ?? {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
          out[k] = JSON.parse(trimmed);
          continue;
        } catch {
          // 保留原值
        }
      }
      if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try {
          out[k] = JSON.parse(trimmed);
          continue;
        } catch {
          // 保留原值
        }
      }
    }
    out[k] = v;
  }
  return out;
}

export function cwdFromMetadata(rawContent) {
  const s = String(rawContent ?? '');
  const cmdCwd = /^\s*Command Working Directory:\s*(.+)$/im.exec(s)?.[1]?.trim();
  if (cmdCwd) return cmdCwd;
  const activeWs = /Active Workspaces:\s*\r?\n-\s*(.+)$/im.exec(s)?.[1]?.trim();
  return activeWs || null;
}

export function antigravityHead(records) {
  const out = { cwd: null, firstTs: null, parentId: null };
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (out.firstTs === null && r.created_at) out.firstTs = r.created_at;
    if (out.cwd === null && r.type === 'USER_INPUT' && typeof r.content === 'string') {
      out.cwd = cwdFromMetadata(r.content);
    }
  }
  return out;
}

export function antigravityFirstUserText(records) {
  for (const r of records) {
    if (!r || typeof r !== 'object' || r.type !== 'USER_INPUT') continue;
    const t = extractUserRequest(r.content);
    if (t) return t.slice(0, 500);
  }
  return null;
}

export function antigravityTail(records) {
  let lastTs = null;
  for (const r of records) {
    if (r && typeof r === 'object' && r.created_at) lastTs = r.created_at;
  }
  return { lastTs };
}

function tokensFrom(r) {
  if (typeof r?.input_tokens !== 'number' && typeof r?.output_tokens !== 'number') return undefined;
  return {
    input: r.input_tokens ?? 0,
    output: r.output_tokens ?? 0,
    cacheRead: r.cache_read_tokens ?? 0,
    cacheWrite: 0,
    thinking: 0,
  };
}

function stripToolResultHeaders(raw) {
  return String(raw ?? '').replace(
    /^(?:\s*Created At:\s*[^\r\n]*\r?\n(?:\s*Completed At:\s*[^\r\n]*\r?\n)?(?:\s*Showing lines [^\r\n]*\r?\n)?)+/,
    '',
  ).trimStart();
}

/** 检测用户这一步是否通过 `/goal` 设定了长时目标。 */
export function extractGoalCommand(rawContent) {
  const req = extractUserRequest(rawContent);
  if (!req) return null;
  const trimmed = req.trim();
  if (/^\/goal\s+(clear|stop|off|cancel)$/i.test(trimmed)) return { clear: true, condition: '' };
  if (/^\/goal(?:\s+|$)/i.test(trimmed)) {
    return { clear: false, condition: trimmed.replace(/^\/goal\s*/i, '').trim() };
  }
  if (/\/goal(?:\s|$)/i.test(trimmed) || /\/goal is a \[Slash Command\]/i.test(String(rawContent ?? ''))) {
    const cleaned = trimmed.replace(/(?:^|\s)\/goal(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();
    return { clear: false, condition: cleaned || trimmed };
  }
  return null;
}

/**
 * 将 Antigravity `transcript_full.jsonl`（或降级 `transcript.jsonl`）记录无状态地归一化为 Baton 事件。
 *
 * `paginate.js` 与 `follow.js` 按单行调用，故 tool_call 与 tool_result 必须仅凭自身的 `step_index` 配对：
 * 实测全语料 600+ 步 100% 满足：`PLANNER_RESPONSE` 在 `step_index = S` 发起第 `i` 个工具调用，
 * 其结果 `GENERIC` 恒在 `step_index = S + 1 + i`。
 */
export function antigravityEvents(records) {
  const out = [];
  records.forEach((r, idx) => {
    if (!r || typeof r !== 'object') return;
    const step = Number.isInteger(r.step_index) ? r.step_index : idx;
    const anchor = `step:${step}`;
    const ts = r.created_at ?? null;

    if (r.type === 'USER_INPUT') {
      const userText = extractUserRequest(r.content);
      if (userText) {
        out.push(makeEvent({ id: `${anchor}#0`, ts, role: 'user', kind: 'text', text: userText }));
      }
      const goal = extractGoalCommand(r.content);
      if (goal && !goal.clear && goal.condition) {
        out.push(makeEvent({
          id: `${anchor}#goal`, ts, role: 'system', kind: 'goal', text: goal.condition,
          goal: { met: false, reason: null },
        }));
      }
      return;
    }

    if (r.type === 'PLANNER_RESPONSE') {
      let sub = 0;
      const tokens = tokensFrom(r);
      if (typeof r.thinking === 'string' && r.thinking.trim()) {
        out.push(makeEvent({
          id: `${anchor}#${sub++}`, ts, role: 'agent', kind: 'thinking', text: r.thinking.trim(), tokens,
        }));
      }
      const hasGoalDone = typeof r.content === 'string' && r.content.includes('<!-- GOAL_COMPLETE -->');
      const bodyText = typeof r.content === 'string'
        ? r.content.replace(/<!--\s*GOAL_COMPLETE\s*-->/g, '').trim()
        : '';
      if (bodyText) {
        out.push(makeEvent({
          id: `${anchor}#${sub++}`, ts, role: 'agent', kind: 'text', text: bodyText, tokens,
        }));
      }
      const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
      calls.forEach((tc, ci) => {
        const callId = Number.isInteger(r.step_index) ? `step:${r.step_index + 1 + ci}` : `${anchor}:call:${ci}`;
        out.push(makeEvent({
          id: `${anchor}#call:${ci}`, ts, role: 'agent', kind: 'tool_call',
          tool: { name: tc?.name ?? null, id: callId, input: normalizeToolArgs(tc?.args ?? {}) },
          tokens,
        }));
      });
      if (hasGoalDone) {
        out.push(makeEvent({
          id: `${anchor}#goal`, ts, role: 'system', kind: 'goal', text: '任务目标已达成',
          goal: { met: true, reason: '模型输出 GOAL_COMPLETE 标记' },
        }));
      }
      if (calls.length === 0 && r.status === 'DONE' && tokens) {
        out.push(makeEvent({
          id: `${anchor}#end`, ts, role: 'system', kind: 'turn_end', tokens,
        }));
      }
      return;
    }

    if (r.type === 'GENERIC') {
      const output = stripToolResultHeaders(r.content);
      const failed = r.status === 'ERROR' || /^Command exited with code (?!0\b)-?\d+\./m.test(output);
      out.push(makeEvent({
        id: `${anchor}#0`, ts, role: 'system', kind: 'tool_result',
        tool: { name: null, id: anchor, output, ...(failed ? { failed: true } : {}) },
      }));
      return;
    }

    if (r.type === 'ERROR_MESSAGE') {
      const err = text(r.error) ?? text(r.content) ?? 'Antigravity 执行出错';
      out.push(makeEvent({ id: `${anchor}#0`, ts, role: 'system', kind: 'turn_end', error: err }));
      return;
    }

    if (r.type === 'CHECKPOINT') {
      out.push(makeEvent({
        id: `${anchor}#0`, ts, role: 'system', kind: 'command_output', text: '上下文已压缩（Checkpoint）',
      }));
      return;
    }

    if (r.type === 'SYSTEM_MESSAGE') {
      const content = String(r.content ?? '');
      if (/\b(?:cancelled by user|interrupted by user|request interrupted)\b/i.test(content)) {
        out.push(makeEvent({ id: `${anchor}#0`, ts, role: 'system', kind: 'interrupt', text: '这一轮被打断' }));
      }
    }
  });
  return out;
}
