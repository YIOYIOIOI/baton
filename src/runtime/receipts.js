import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BATON_DIR } from '../config.js';

export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 10000;
const database = (dir) => path.join(dir, 'send-receipts.sqlite');
const pendingRepair = new Map();

function receiptKey({ key, principalId, principalGeneration, request }) {
  return crypto.createHash('sha256').update(JSON.stringify([key, principalId, principalGeneration ?? null, request.id])).digest('hex');
}

export function findReceipt(record, { dir = BATON_DIR, now = Date.now() } = {}) {
  const file = database(dir);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipts'").get()) return null;
    const row = db.prepare('SELECT signature, queueId, turnId FROM receipts WHERE token = ? AND expires > ?').get(receiptKey(record), now);
    return row ? { request: { signature: row.signature }, queueId: row.queueId, turnId: row.turnId } : null;
  } finally { db.close(); }
}

// Commit the original acceptance alongside the synchronous queue/turn write. That record also carries the
// request identity in case the process exits between the filesystem write and the SQLite transaction commit.
export function withReceipt(record, write, { dir = BATON_DIR, now = Date.now(), limit = MAX_RECEIPTS,
  allowSourceOnly = false, durableSource = false } = {}) {
  if (!record.request) return write();
  const pending = pendingRepair.get(dir);
  if (pending && !allowSourceOnly) {
    if (pending.expires > now) {
      try { storeReceipt(pending.record, () => {}, dir, now, limit, false, false); } catch (cause) {
        throw Object.assign(new Error('发送回执暂时无法保存。', { cause }), { code: 'receipt_store_unavailable' });
      }
    }
    pendingRepair.delete(dir);
  }
  return storeReceipt(record, write, dir, now, limit, allowSourceOnly, durableSource);
}

function storeReceipt(record, write, dir, now, limit, allowSourceOnly, durableSource) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(database(dir));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS receipts (token TEXT PRIMARY KEY, signature TEXT NOT NULL, queueId TEXT, turnId TEXT, expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS expiry ON receipts(expires)');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM receipts WHERE expires <= ?').run(now);
    const token = receiptKey(record);
    const old = db.prepare('SELECT token FROM receipts WHERE token = ?').get(token);
    if (old) db.prepare('UPDATE receipts SET expires = ? WHERE token = ?').run(now + RETRY_WINDOW_MS, token);
    else {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM receipts').get();
      if (Number(n) >= limit) {
        if (!allowSourceOnly) throw Object.assign(new Error('发送回执暂时已满，请稍后重试。'), { code: 'request_history_full' });
      } else {
        db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?)').run(token, record.request.signature,
          record.queueId ?? record.id ?? null, record.turnId ?? null, now + RETRY_WINDOW_MS);
      }
    }
    const result = write();
    try { db.exec('COMMIT'); } catch (error) {
      if (!durableSource) throw error;
      // The queue entry or running turn is already durable. Its embedded receipt is
      // authoritative until the index can commit; startTurn must still publish and run.
      if (!pendingRepair.has(dir)) {
        const { key, principalId, principalGeneration, request, id, queueId, turnId } = record;
        pendingRepair.set(dir, { record: { key, principalId, principalGeneration, request, id, queueId, turnId },
          expires: now + RETRY_WINDOW_MS });
      }
      console.warn(`发送回执索引暂时无法提交，已保留原始记录（${error.code ?? error.message}）。`);
    }
    return result;
  } finally { db.close(); }
}

// A crash can leave the queue item or turn on disk before SQLite committed. Preserve that
// original acceptance before deleting the last filesystem copy during the retry window.
export function preserveReceipt(record, { dir = BATON_DIR, now = Date.now() } = {}) {
  if (!record.request || (record.queuedAt ?? record.startedAt) + RETRY_WINDOW_MS <= now || findReceipt(record, { dir, now })) return;
  withReceipt(record, () => {}, { dir, now });
}
