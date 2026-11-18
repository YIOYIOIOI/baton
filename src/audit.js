import fs from 'node:fs';
import path from 'node:path';
import { BATON_DIR } from './config.js';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded(file, maxBytes) {
  try {
    if (fs.statSync(file).size < maxBytes) return;
    const backup = `${file}.1`;
    try {
      fs.unlinkSync(backup);
    } catch {
      // no prior backup
    }
    fs.renameSync(file, backup);
  } catch {
    // file does not exist yet
  }
}

/**
 * Append a structured event to `audit.log` (mode 0600) with bounded size rotation.
 * @param {Record<string, unknown>} event
 * @param {{ dir?: string, maxBytes?: number }} [opts]
 */
export function appendAuditEvent(event, { dir = BATON_DIR, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const file = path.join(dir, 'audit.log');
  fs.mkdirSync(dir, { recursive: true });
  rotateIfNeeded(file, maxBytes);
  const entry = { ts: new Date().toISOString(), ...event };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// Legacy helper preserving 80-char preview format without storing full user prompts.
export function appendAudit(
  {
    key, agent, message, turnId, status, principal,
  },
  { dir = BATON_DIR, maxBytes = DEFAULT_MAX_BYTES } = {},
) {
  const text = String(message ?? '');
  appendAuditEvent({
    principal: principal ?? 'owner',
    key,
    agent,
    turnId,
    status,
    length: text.length,
    preview: text.replace(/\s+/g, ' ').slice(0, 80),
  }, { dir, maxBytes });
}
