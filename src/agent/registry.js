import fs from 'node:fs';
import path from 'node:path';
import { claudeRegistryRoots } from '../titles.js';

// 桌面 App 的会话注册项。铁律：只写索引文件，绝不碰 transcript。
// 注册项的最小必需字段集未知（cliBinaryPin / promptAppendSnapshot / settingsKey
// 语义不明），故以现有条目为模板复制，只改确知的那些字段。

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** @param {{ root?: string, roots?: string[] }} [opts] */
export function pickRegistryDir({ root, roots } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    // 备份目录里的 cliSessionId 与活动目录重复（实测 3 条），选中它会造成重复身份
    if (/\.backup-/.test(path.basename(dir))) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json'))
      .map((e) => e.name);
    if (files.length) found.push({ dir, files });
    if (depth < 3) {
      for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots ?? (root !== undefined ? [root] : claudeRegistryRoots())) {
    walk(r, 0);
  }
  if (!found.length) return null;
  found.sort((a, b) => b.files.length - a.files.length);
  return found[0];
}

export function loadTemplate(picked) {
  if (!picked) return null;
  let fallback = null;
  for (const name of picked.files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(picked.dir, name), 'utf8'));
      if (!raw.cliSessionId) continue;
      if (raw.isArchived !== true) return raw;
      fallback ??= raw;
    } catch {
      // 坏条目跳过
    }
  }
  return fallback;
}

export function buildRegistryEntry({ template, cliSessionId, cwd, title, now = Date.now() }) {
  if (!UUID.test(String(cliSessionId))) {
    throw new Error(`拒绝写注册项：cliSessionId 必须是标准 uuid（收到 ${JSON.stringify(cliSessionId)}）`);
  }
  const entry = { ...(template && typeof template === 'object' ? template : {}) };
  entry.sessionId = `local_${cliSessionId}`;
  entry.cliSessionId = cliSessionId;
  entry.cwd = cwd;
  entry.originCwd = cwd;
  entry.title = title;
  entry.titleSource = 'auto';
  entry.isArchived = false;
  entry.createdAt = now;
  entry.lastActivityAt = now;
  entry.lastFocusedAt = now;
  // 新建的会话不是分叉，留着这两个字段会让 App 误以为它有来源
  delete entry.forkedFromSessionId;
  delete entry.forkedAtMessageUuid;
  return entry;
}

export function writeRegistryEntry(entry, { dir }) {
  const file = path.join(dir, `local_${entry.cliSessionId}.json`);
  return writeAtomic(file, entry);
}

function writeAtomic(file, entry) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 1));
  fs.renameSync(tmp, file); // 原子替换，避免 App 读到半个文件
  return file;
}

/**
 * 给已经写好的注册项换个标题——起名是并着第一轮跑的，回来时注册项早写完了
 * （见 agent/title.js）。
 *
 * **读回来再改，不是照内存里那份重写**：这中间 App 可能已经动过它（它每次
 * 交互都在写），照旧的覆盖就是把 App 的改动抹掉。
 *
 * 人在 App 里自己改过名字（titleSource 是 user 或 tool）就不动——保留用户在
 * 桌面 App 内手动重命名的标题不被自动标题覆盖。
 *
 * @param {string} file 注册项路径（defaultRegistrar 的返回值）
 * @param {string} title
 * @returns {boolean} 真的改了才是 true
 */
export function retitleRegistryEntry(file, title) {
  const next = String(title ?? '').trim();
  if (!file || !next) return false;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // 注册项没了（会话在 App 里被删了）就当没这回事
  }
  if (!entry?.cliSessionId) return false;
  if (entry.titleSource === 'user' || entry.titleSource === 'tool') return false;
  if (entry.title === next) return false;
  entry.title = next;
  entry.titleSource = 'auto';
  writeAtomic(file, entry);
  return true;
}
