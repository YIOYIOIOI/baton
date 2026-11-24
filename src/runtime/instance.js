import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let instanceId = null;
let closing = false;
const executions = new Map();

/** SQLite's exclusive lock belongs to the open connection and is released by the OS on a crash. */
export function acquireInstance(dir) {
  if (instanceId) throw new Error('本进程已经持有一个 Baton 数据目录。');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'daemon-lock.sqlite'));
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if (error.errcode === 5 || error.errcode === 6) throw new Error(`另一个 Baton 实例正在使用数据目录 ${dir}。`);
    throw error;
  }
  const id = crypto.randomUUID();
  instanceId = id;
  closing = false;
  return { id, release() {
    if (instanceId !== id) return;
    db.close();
    instanceId = null;
    closing = false;
    executions.clear();
  } };
}

export const currentInstanceId = () => instanceId;
export const isShuttingDown = () => closing;

export function beginExecution(turnId) {
  if (!instanceId) return;
  const stopped = Promise.withResolvers();
  executions.set(turnId, { stopped, handle: null, onStop: null, requested: false, recoverable: false });
}

function requestShutdown(entry) {
  if (!entry.handle || entry.requested) return;
  if (entry.handle.canStop === false) {
    // 已落盘的桌面轮次交给下一实例接续监控。尚未认领会话的，等待可恢复的身份。
    if (entry.recoverable) entry.stopped.resolve();
    return;
  }
  if (typeof entry.handle.kill !== 'function') return;
  entry.requested = true;
  try { entry.onStop?.(); } catch (error) { console.error(`停止请求未能登记：${error.message}`); }
  try { entry.handle.kill(); } catch { entry.requested = false; }
}

export function executionHandle(turnId, handle, onStop = null, recoverable = false) {
  const entry = executions.get(turnId);
  if (!entry) return;
  Object.assign(entry, { handle, onStop, recoverable });
  if (closing) requestShutdown(entry);
}

export function finishExecution(turnId) {
  executions.get(turnId)?.stopped.resolve();
  executions.delete(turnId);
}

export async function shutdownExecutions() {
  closing = true;
  const entries = [...executions.values()];
  for (const entry of entries) requestShutdown(entry);
  if (!entries.length) return;
  const retry = setInterval(() => { for (const entry of executions.values()) requestShutdown(entry); }, 1000);
  try { await Promise.all(entries.map((entry) => entry.stopped.promise)); } finally { clearInterval(retry); }
}
