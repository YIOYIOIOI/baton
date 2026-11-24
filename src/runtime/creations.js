import fs from 'node:fs';
import path from 'node:path';
import { BATON_DIR } from '../config.js';
import { writeJsonAtomic } from '../json-store.js';
import { createdConversationObserver, sameDesktopWorkspace } from '../agent/antigravityRun.js';
import { scopedPath, scopeRepo } from '../scope.js';
import { currentInstanceId } from './instance.js';
import { decodeKey, encodeKey } from '../providers.js';
import { listTurns, startTurn } from './turns.js';
import { setEffort, setModel } from './prefs.js';

const receiptDir = (dir) => path.join(dir, 'session-creations');
const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const indexes = new Map();

function boundDirectory(record, dir) {
  if (record.directory === '' || record.directory === 'antigravity') return record.directory;
  if (record.status !== 'identified' || !record.key) return null;
  try {
    const { relPath } = decodeKey(record.key, { antigravity: dir });
    const match = /^(?:(antigravity)\/)?brain\/([^/]+)\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/.exec(relPath);
    return match?.[2] === record.sessionId ? match[1] ?? '' : null;
  } catch { return null; }
}

function indexed(record, dir) {
  if (record.status !== 'identified' || record.directory !== undefined) return record;
  return { ...record, directory: boundDirectory(record, dir) };
}

function desktopKeys(directory, sessionId) {
  if ((directory !== 'antigravity' && directory !== '') || typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return [];
  const prefix = (directory ? directory + '/' : '') + 'brain/' + sessionId + '/.system_generated/logs/';
  return ['transcript_full.jsonl', 'transcript.jsonl'].map((name) => encodeKey('antigravity', prefix + name));
}

export function boundCreationKey(receipt, repo, dir = BATON_DIR) {
  const directory = boundDirectory(receipt, dir);
  const keys = [receipt.key, ...desktopKeys(directory, receipt.sessionId)];
  const cwd = receipt.workspace?.path ?? receipt.cwd;
  for (const key of new Set(keys)) {
    if (key && sameDesktopWorkspace(cwd, repo.getSession(key)?.cwd, receipt.workspace)) return key;
  }
  return null;
}

export function saveCreation(record, dir = BATON_DIR) {
  if (!validId(record.turnId)) throw new Error('新建回执标识无效');
  fs.mkdirSync(receiptDir(dir), { recursive: true, mode: 0o700 });
  writeJsonAtomic(path.join(receiptDir(dir), record.turnId + '.json'), record);
  indexes.get(dir)?.set(record.turnId, indexed(record, dir));
  return record;
}

export function readCreation(id, dir = BATON_DIR) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(receiptDir(dir), id + '.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function settleCreation(record, fields, dir = BATON_DIR) {
  const { evidence: _evidence, prompt: _prompt, reservation: _reservation, ...receipt } = record;
  return saveCreation({ ...receipt, ...(_evidence?.workspace ? { workspace: _evidence.workspace } : {}), ...fields }, dir);
}

function creationIndex(dir) {
  if (indexes.has(dir)) return indexes.get(dir);
  const index = new Map();
  try {
    for (const name of fs.readdirSync(receiptDir(dir))) {
      const id = name.slice(0, -5);
      if (!name.endsWith('.json') || !validId(id)) continue;
      const receipt = readCreation(id, dir);
      if (receipt) index.set(id, indexed(receipt, dir));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  indexes.set(dir, index);
  return index;
}

export function mayClaimCreation(receipt, match, dir = BATON_DIR) {
  if (!receipt || !match) return false;
  const requested = receipt.evidence?.cwd ?? receipt.cwd;
  if (!sameDesktopWorkspace(requested, match.cwd, receipt.evidence?.workspace)) return false;
  const owns = (identity) => identity?.sessionId === match.id && identity.directory === match.directory;
  if (receipt.reservation && !owns(receipt.reservation)) return false;
  if (receipt.evidence?.claimedId && receipt.evidence.claimedId !== match.id) return false;
  const text = (s) => s.trim().replaceAll('\r\n', '\n');
  for (const other of creationIndex(dir).values()) {
    if (other.turnId === receipt.turnId) continue;
    if (other.key === match.key || owns(other) || owns(other.reservation)) return false;
    if (receipt.reservation) continue;
    const evidence = other.evidence;
    const cwd = evidence?.cwd ?? other.cwd;
    if (other.status !== 'unconfirmed' || !evidence || text(other.prompt) !== text(receipt.prompt)
      || !sameDesktopWorkspace(cwd, match.cwd, evidence.workspace)) continue;
    if (evidence.projectId && match.projectId && evidence.projectId !== match.projectId) continue;
    if (evidence.baseline.some(([directory, ids]) => directory === match.directory && ids.includes(match.id))) continue;
    if (evidence.claimedId ? evidence.claimedId === match.id : !receipt.evidence?.claimedId) return false;
  }
  return true;
}

// The daemon holds an exclusive data-directory lease. Reserve the physical desktop session
// before writing its first turn so a crash between the two files cannot assign it twice.
export function reserveCreation(receipt, match, dir = BATON_DIR) {
  if (!mayClaimCreation(receipt, match, dir)) return null;
  const key = receipt.reservation?.key ?? match.key;
  if (!desktopKeys(match.directory, match.id).includes(key)) return null;
  return receipt.reservation?.key ? receipt : saveCreation({ ...receipt, reservation: { sessionId: match.id, directory: match.directory, key } }, dir);
}

// Pick up only submissions left by a previous daemon. This path never opens a bridge connection.
export function unboundCreationRecovery(repo, { dir = BATON_DIR, onBound = (_turn) => {}, geminiRoot = undefined, principalOf = null } = {}) {
  const pending = new Map();
  let initialized = false;
  return () => {
    if (!initialized) {
      try {
        for (const [id, receipt] of creationIndex(dir)) {
          if (receipt.status === 'unconfirmed' && receipt.evidence && !(receipt.ownerId && receipt.ownerId === currentInstanceId())) pending.set(id, null);
        }
        initialized = true;
      } catch { return 1; }
    }
    for (const [id, previous] of pending) {
      try {
        const receipt = creationIndex(dir).get(id);
        if (receipt?.status !== 'unconfirmed' || !receipt.evidence) { pending.delete(id); continue; }
        const principal = principalOf?.(receipt.principalId);
        if (receipt.principalId !== 'owner' && (!principal || (principal.generation ?? null) !== receipt.generation)) { pending.delete(id); continue; }
        if (!scopedPath(receipt.cwd, principal)) continue;
        const evidence = { ...receipt.evidence, cwd: receipt.evidence.cwd ?? receipt.cwd };
        const observe = previous ?? createdConversationObserver(evidence, receipt.prompt, geminiRoot, (match) => mayClaimCreation(receipt, match, dir));
        pending.set(id, observe);
        const { match } = observe();
        if (!match) continue;
        const member = scopeRepo(repo, principal).getSession(match.key);
        if (!member) continue;
        // The host may switch transcripts after the first turn is durable but before its
        // receipt is marked identified. Only these two keys describe this physical session.
        const keys = desktopKeys(match.directory, match.id);
        const search = new Set([receipt.reservation?.key, match.key, ...keys]);
        let existing = null;
        for (const key of search) {
          if (!keys.includes(key)) continue;
          existing = listTurns(key, { dir }).find((entry) => entry.turnId === id && entry.key === key);
          if (existing) break;
        }
        const reserved = reserveCreation(receipt, { ...match, cwd: member.cwd, key: existing?.key ?? match.key }, dir);
        if (!reserved) continue;
        const monitor = { conversationId: match.id, directory: match.directory, baselineStep: -1, sawRunning: false, awaitingIdle: false };
        const turn = existing ?? startTurn({
          key: reserved.reservation.key, turnId: id, agent: 'antigravity', prompt: receipt.prompt,
          principalId: receipt.principalId, principalGeneration: receipt.generation,
          adoptedDesktop: { ownerId: receipt.ownerId, monitor },
        }, { dir, now: receipt.startedAt });
        if (receipt.model) setModel(turn.key, receipt.model, { dir });
        if (receipt.effort) setEffort(turn.key, receipt.effort, { dir });
        if (turn.status === 'running') onBound(turn);
        settleCreation(reserved, { status: 'identified', sessionId: match.id, directory: match.directory, key: turn.key }, dir);
        pending.delete(id);
      } catch { /* Retry transient summary, transcript or storage errors on the following observation. */ }
    }
    return pending.size;
  };
}
