import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Serialize local JSON read-modify-write operations across the daemon and CLI. */
export function withJsonWriteLock(file, update) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = new DatabaseSync(`${file}.lock.sqlite`, { timeout: 1500 });
  try {
    lock.exec('BEGIN IMMEDIATE');
    return update();
  } finally {
    lock.close();
  }
}

export function writeJsonAtomic(file, state) {
  const text = JSON.stringify(state, null, 2);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600, flush: true });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* Keep the original storage error. */ }
    throw err;
  }
  return text;
}
