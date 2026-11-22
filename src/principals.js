import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BATON_DIR, loadConfig } from './config.js';
import { canonicalPath, under } from './scope.js';

export const OWNER_ID = 'owner';

// owner 就是「没有 roots 的那一个」。这不是特例分支，而是 inScope 的边界值：
// roots === null 恒真。allowSend 为 null 表示继承全局配置。
export const OWNER = Object.freeze({
  id: OWNER_ID, name: OWNER_ID, roots: null, allowSend: null,
});

// id 会进 HMAC 的 salt 字符串，保持无聊
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const GUEST_FIELDS = new Set(['id', 'name', 'root', 'allowSend', 'credentialVersion']);
const managed = new WeakMap();
const grantValue = (guest) => guest.allowSend == null ? null : Number(guest.allowSend);
// Valid grants are NULL (inherit), 0 and 1. A suspended row retains its credential generation.
const SUSPENDED_GRANT = -1;

/** A second daemon sharing this installation can rotate an enrollment while the first is draining. */
export function isCurrentPrincipal(principal) {
  const file = managed.get(principal);
  if (!file) return true;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 150 });
    return Boolean(db.prepare('SELECT 1 FROM guests WHERE id=? AND generation=? AND allow_send IS ?')
      .get(principal.id, principal.generation, grantValue(principal)));
  } catch { return false; } finally { db?.close(); }
}

/** Only a readable enrollment ledger can authorize discarding an accepted queue item. */
export function revokedQueueGrant(id, generation, dir = BATON_DIR) {
  let db;
  try {
    db = new DatabaseSync(path.join(dir, 'principal-generations.sqlite'), { readOnly: true, timeout: 150 });
    if (db.prepare('PRAGMA user_version').get().user_version !== 1) return false;
    const row = db.prepare('SELECT generation, legacy, allow_send FROM guests WHERE id=?').get(id);
    if (!row) return true;
    if (typeof row.generation !== 'string' || !row.generation || (row.legacy !== 0 && row.legacy !== 1)
        || (row.allow_send !== null && row.allow_send !== 0 && row.allow_send !== 1)) return false;
    return row.allow_send === 0 || (generation ? row.generation !== generation : row.legacy === 0);
  } catch { return false; } finally { db?.close(); }
}

/**
 * 读 ~/.baton/principals.json。
 *
 * **任何一条不合法都只跳过那一条并记一条可操作的 errors，绝不抛。**
 * 抛出去会让守护进程起不来，而起不来的后果比少一个访客严重得多。
 * 调用方（cli.js）负责把 errors 印在启动横幅里——不静默是硬要求。
 */
/**
 * @typedef {{ id: string, name: string, roots: string[] | null, realRoots?: string[], allowSend: boolean | null, credentialVersion?: number, generation?: string, acceptLegacy?: boolean }} Principal
 * @param {{ dir?: string, workspacesRoot?: string }} [opts]
 * @returns {{ principals: Principal[], errors: string[], configuredIds: Set<string>|null }}
 */
function readPrincipals({ dir = BATON_DIR, workspacesRoot } = {}) {
  const base = workspacesRoot ?? loadConfig({ dir }).workspacesRoot;
  const file = path.join(dir, 'principals.json');
  const errors = [];

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      errors.push(`${file} 读不了或不是合法 JSON（${err.message}）。已按「只有 owner」运行；`
        + '修好这个文件并重启 Baton 之后访客才会生效。');
    }
    return { principals: [OWNER], errors, configuredIds: err.code === 'ENOENT' ? new Set() : null };
  }

  const staged = [];
  const seen = new Set();
  if (!Array.isArray(raw?.guests) || Object.keys(raw).some((k) => k !== 'guests')) {
    errors.push(`${file} 应为含 guests 数组的对象，例如 {"guests":[{"id":"friend"}]}。`);
    return { principals: [OWNER], errors, configuredIds: null };
  }
  const configuredIds = new Set();
  for (const g of raw.guests) {
    const id = typeof g?.id === 'string' ? g.id : '';
    if (!ID_RE.test(id)) {
      errors.push(`跳过一条访客：id ${JSON.stringify(g?.id)} 非法。`
        + '只允许小写字母、数字、下划线、短横线，首字符为字母或数字，最长 32。');
      continue;
    }
    if (id === OWNER_ID) {
      errors.push(`跳过访客 "${id}"：owner 是保留字，不能用作访客的 id。换一个 id。`);
      continue;
    }
    configuredIds.add(id);
    if (seen.has(id)) {
      errors.push(`跳过重复的访客 "${id}"：同一个 id 只能出现一次，后面那条被忽略了。`);
      continue;
    }
    const unknown = Object.keys(g).find((k) => !GUEST_FIELDS.has(k));
    if (unknown || (g.name !== undefined && (typeof g.name !== 'string' || !g.name.trim()))
      || (g.allowSend !== undefined && typeof g.allowSend !== 'boolean')
      || (g.credentialVersion !== undefined && (!Number.isSafeInteger(g.credentialVersion) || g.credentialVersion < 1))) {
      errors.push(`跳过访客 "${id}"：${unknown ? `未知字段 ${unknown}。` : ''}name 应为非空字符串，allowSend 应为布尔值，credentialVersion 应为正整数；目录字段为 root。`);
      continue;
    }
    if (g.root !== undefined && (typeof g.root !== 'string' || !path.isAbsolute(g.root))) {
      errors.push(`跳过访客 "${id}"：root 必须是绝对路径（收到 ${JSON.stringify(g.root)}）。`
        + `整个删掉 root 这个字段则用默认值 ${path.join(base, id)}。`);
      continue;
    }
    const root = g.root ?? path.join(base, id);
    const realRoot = canonicalPath(root);
    if (!realRoot) {
      errors.push(`跳过访客 "${id}"：无法确定工作区 ${root} 的实际位置，请检查目录权限和链接。`);
      continue;
    }
    seen.add(id);
    staged.push({
      id,
      name: typeof g.name === 'string' && g.name ? g.name : id,
      roots: [root],
      // 工作区的别名可以变，授权时的实际位置固定到下次加载配置。
      realRoots: [realRoot],
      allowSend: typeof g.allowSend === 'boolean' ? g.allowSend : null,
      ...(g.credentialVersion !== undefined ? { credentialVersion: g.credentialVersion } : {}),
    });
  }

  // 嵌套检查必须在 root **解析之后**：id 唯一时默认 root 之间不可能嵌套，
  // 但一个自定义 root 完全可能落进另一个访客的默认 root 里，
  // 那样「这个会话属于谁」就有两个答案。
  const kept = [];
  for (const g of staged) {
    const clash = kept.find((k) => overlaps(g.roots[0], k.roots[0]) || overlaps(g.realRoots[0], k.realRoots[0]));
    if (clash) {
      errors.push(`跳过访客 "${g.id}"：它的 root ${g.roots[0]} 与 "${clash.id}" 的 `
        + `${clash.roots[0]} 互相嵌套，同一个会话会有两个归属。给它们各自独立的目录。`);
      continue;
    }
    kept.push(g);
  }

  return { principals: [OWNER, ...kept], errors, configuredIds };
}

/** @param {{ dir?: string, workspacesRoot?: string, manageGenerations?: boolean }} [opts] */
export function loadPrincipals(opts = {}) {
  if (!opts.manageGenerations) {
    const { principals, errors } = readPrincipals(opts);
    return { principals, errors };
  }
  const dir = opts.dir ?? BATON_DIR;
  const file = path.join(dir, 'principal-generations.sqlite');
  const marker = path.join(dir, 'principal-generations.ready');
  let errors = [];
  let db;
  try {
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(file, { timeout: 1500 });
    db.exec('BEGIN IMMEDIATE');
    const result = readPrincipals(opts);
    errors = result.errors;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1) throw new Error('不支持的身份代际表版本。');
    if (version === 0) {
      try {
        fs.statSync(marker);
        throw new Error('身份代际账本丢失，请从备份恢复。');
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (!result.configuredIds) return { principals: [OWNER], errors };
      db.exec('CREATE TABLE guests (id TEXT PRIMARY KEY, identity TEXT NOT NULL, generation TEXT NOT NULL, legacy INTEGER NOT NULL, allow_send INTEGER); PRAGMA user_version=1');
    }
    const previous = new Map(db.prepare('SELECT * FROM guests').all().map((row) => [row.id, row]));
    const save = db.prepare('INSERT OR REPLACE INTO guests VALUES (?, ?, ?, ?, ?)');
    /** @type {Principal[]} */
    const principals = [OWNER];
    for (const guest of result.principals) {
      if (guest.id === OWNER_ID) continue;
      const identity = createHash('sha256').update(JSON.stringify([guest.name, guest.realRoots, guest.credentialVersion ?? null])).digest('hex');
      const old = previous.get(guest.id);
      const same = old?.identity === identity;
      if (same && (typeof old.generation !== 'string' || !old.generation || (old.legacy !== 0 && old.legacy !== 1))) {
        throw new Error('访客身份记录损坏。');
      }
      const generation = same ? String(old.generation) : randomUUID();
      const acceptLegacy = same ? old.legacy === 1 : version === 0 && guest.credentialVersion === undefined;
      const grant = grantValue(guest);
      if (!same || old.allow_send !== grant) save.run(guest.id, identity, generation, Number(acceptLegacy), grant);
      const enrolled = { ...guest, generation, acceptLegacy };
      managed.set(enrolled, file);
      principals.push(enrolled);
      previous.delete(guest.id);
    }
    const remove = db.prepare('DELETE FROM guests WHERE id=?');
    const suspend = db.prepare('UPDATE guests SET allow_send=? WHERE id=?');
    for (const id of previous.keys()) {
      if (!result.configuredIds || result.configuredIds.has(String(id))) suspend.run(SUSPENDED_GRANT, id);
      else remove.run(id);
    }
    db.exec('COMMIT');
    try { fs.writeFileSync(marker, '1\n', { flag: 'wx', mode: 0o600, flush: true }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    return { principals, errors };
  } catch (err) {
    return { principals: [OWNER], errors: [...errors, `无法验证访客身份代际，已暂停访客访问：${err.message}`] };
  } finally { db?.close(); }
}

function overlaps(a, b) {
  return under(a, b) || under(b, a);
}

/**
 * 访客的工作区目录不存在就建出来。
 *
 * 建而不是报错：路径是 owner 自己配的（或由默认值推出来的），不建的话
 * 访客第一步就撞墙，而他看到的错误只会指向一个他无权创建的目录。
 */
export function ensureRoots(principals, { mkdir = fs.mkdirSync, exists = fs.existsSync } = {}) {
  const out = [];
  for (const g of principals) {
    if (!g.roots) continue; // owner 没有 roots
    for (const [i, root] of g.roots.entries()) {
      const pinned = g.realRoots?.[i];
      if (pinned && canonicalPath(root) !== pinned) {
        out.push({ id: g.id, root, created: false, error: '工作区链接的位置已改变，请核对配置。' });
        continue;
      }
      const target = pinned ?? root;
      if (exists(target)) {
        out.push({ id: g.id, root, created: false, error: null });
        continue;
      }
      try {
        mkdir(target, { recursive: true });
        out.push({ id: g.id, root, created: true, error: null });
      } catch (err) {
        // 建不出来不能拖垮启动：记下原因，由横幅报给 owner
        out.push({ id: g.id, root, created: false, error: err.message });
      }
    }
  }
  return out;
}
