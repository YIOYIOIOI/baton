import path from 'node:path';
import { readRangeWithOffsets, parseLines } from './jsonl.js';
import { eventsFor } from './wire.js';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function escapeFence(s) {
  return String(s ?? '').replace(/<\/?details\b[^>]*>/gi, '');
}

function fmtToolPayload(val) {
  if (val == null) return '';
  const text = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
  if (!text) return '';
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Render a normalized list of session events into clean GitHub-Flavored Markdown.
 * @param {{ key?: string, agent?: string, title?: string | null, cwd?: string | null }} member
 * @param {Array<any>} events
 * @param {{ exportedAt?: string, truncated?: boolean, maxMb?: number }} [opts]
 * @returns {string}
 */
export function renderSessionMarkdown(member, events, { exportedAt = new Date().toISOString(), truncated = false, maxMb = 16 } = {}) {
  const title = member.title || member.key || 'Baton Session';
  const dir = member.cwd ? path.basename(member.cwd) || member.cwd : 'N/A';
  const lines = [
    `# ${title}`,
    '',
    `- **Agent**: ${member.agent ?? 'unknown'}`,
    `- **Workspace**: ${dir}`,
    `- **Exported**: ${exportedAt}`,
    '',
  ];
  if (truncated) {
    lines.push(`> Note: Export capped to the latest ${maxMb} MB of transcript history.`, '');
  }

  for (const ev of events) {
    if (ev.kind === 'text') {
      const heading = ev.role === 'user' ? '## User' : '## Assistant';
      const ts = ev.ts ? ` _(${ev.ts})_` : '';
      lines.push(`${heading}${ts}`, '', String(ev.text ?? ''), '');
    } else if (ev.kind === 'thinking') {
      lines.push('<details>', '<summary>Thinking</summary>', '', escapeFence(ev.text ?? ''), '', '</details>', '');
    } else if (ev.kind === 'tool_call') {
      const name = ev.tool?.name || 'Tool';
      lines.push('<details>', `<summary>Tool Call: ${escapeFence(name)}</summary>`, '');
      const payload = fmtToolPayload(ev.tool?.input);
      if (payload) lines.push(payload, '');
      lines.push('</details>', '');
    } else if (ev.kind === 'tool_result') {
      const name = ev.tool?.name || 'Tool Result';
      const badge = ev.tool?.failed ? ' (failed)' : '';
      lines.push('<details>', `<summary>Tool Output: ${escapeFence(name)}${badge}</summary>`, '');
      const payload = fmtToolPayload(ev.tool?.output);
      if (payload) lines.push(payload, '');
      lines.push('</details>', '');
    } else if (ev.kind === 'goal') {
      const st = ev.goal?.status ? ` [${ev.goal.status}]` : '';
      lines.push(`> **Goal${st}:** ${String(ev.text ?? '').replace(/\n/g, '\n> ')}`, '');
    } else if (ev.kind === 'interrupt') {
      lines.push(`> _${String(ev.text ?? 'Interrupted')}_`, '');
    } else if (ev.kind === 'turn_end') {
      const status = ev.outcome || ev.status || 'done';
      lines.push(`---`, `_Turn ${status}_`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Read a session file (bounded tail up to `maxBytes`) and render it as Markdown.
 * @param {any} member
 * @param {{ size?: number, maxBytes?: number, exportedAt?: string }} [opts]
 * @returns {string}
 */
export function buildSessionMarkdown(member, { size = 0, maxBytes = DEFAULT_MAX_BYTES, exportedAt } = {}) {
  const start = Math.max(0, size - maxBytes);
  const { entries } = readRangeWithOffsets(member.file, start, size);
  const events = [];
  for (const e of entries) {
    const records = parseLines([e.line]);
    for (const ev of eventsFor(member, records, { offset: e.offset })) {
      events.push(ev);
    }
  }
  return renderSessionMarkdown(member, events, {
    exportedAt,
    truncated: start > 0,
    maxMb: Math.round(maxBytes / (1024 * 1024)),
  });
}

/**
 * Produce an ASCII-safe downloadable `.md` filename from a session title or key.
 * @param {string | null | undefined} title
 * @returns {string}
 */
export function exportFilename(title) {
  const safeStr = String(title ?? 'session').toWellFormed();
  const noCtrl = Array.from(safeStr, (ch) => (ch.codePointAt(0) < 32 ? '-' : ch)).join('');
  const clean = noCtrl
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const bounded = Array.from(clean).slice(0, 48).join('').replace(/-$/g, '');
  return `baton-${bounded || 'session'}.md`;
}
