import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GEMINI_ROOT, ANTIGRAVITY_PRODUCTS } from './antigravity.js';

export { GEMINI_ROOT };
export const CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
export const CODEX_ROOT = path.join(os.homedir(), '.codex', 'sessions');

const ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))?\.jsonl$/;

export function parseRolloutName(basename) {
  const m = ROLLOUT_RE.exec(basename);
  if (!m) return null;
  return { threadId: m[1], rolloutId: m[2] ?? null };
}

export function encodeKey(agent, relPath) {
  return `${agent}:${Buffer.from(relPath, 'utf8').toString('base64url')}`;
}

export function decodeKey(key, roots) {
  const i = key.indexOf(':');
  if (i < 0) throw new Error(`无法解析 key：${key}`);
  const agent = key.slice(0, i);
  const root = roots?.[agent];
  if (!root) throw new Error(`无法解析 key：未知 agent ${agent}`);
  const relPath = Buffer.from(key.slice(i + 1), 'base64url').toString('utf8');
  if (!relPath || relPath.includes('..') || path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`拒绝该 key：检测到路径穿越（${relPath}）`);
  }
  return { agent, relPath, file: path.join(root, relPath) };
}

function statRef(agent, root, relPath, providerId, rolloutId, project) {
  const file = path.join(root, relPath);
  const st = fs.statSync(file);
  const posixRel = relPath.split(path.sep).join('/');
  return {
    agent,
    providerId,
    rolloutId,
    project,
    relPath: posixRel,
    file,
    size: st.size,
    mtimeMs: st.mtimeMs,
    key: encodeKey(agent, posixRel),
  };
}

/**
 * 已知相对路径的那**一个**文件，按列表的同一套规则做成一条记录；不是会话文件就 null。
 *
 * 给「按 key 取一个会话」用：key 本来就指明了是哪个文件，原来却要把两棵树整个
 * 列一遍再从里面找（实测每次 9 ms，全是同步读盘）。规则必须与下面两个列举函数
 * 逐条一致，否则同一个 key 从列表进和直接进会得到两种结果：
 *   claude  只认 <项目>/<会话>.jsonl 这一层，subagents/ 下的不是会话
 *   codex   文件名得是 rollout-<时间戳>-<uuid>[_<uuid>].jsonl
 */
export function sessionRef(agent, root, relPath) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const rel = path.join(...parts);
  try {
    if (!fs.statSync(path.join(root, rel)).isFile()) return null;
  } catch {
    return null; // 文件不在了
  }
  if (agent === 'claude') {
    if (parts.length !== 2 || !parts[1].endsWith('.jsonl')) return null;
    return statRef('claude', root, rel, parts[1].replace(/\.jsonl$/, ''), null, parts[0]);
  }
  if (agent === 'codex') {
    const parsed = parseRolloutName(parts.at(-1) ?? '');
    return parsed ? statRef('codex', root, rel, parsed.threadId, parsed.rolloutId, null) : null;
  }
  if (agent === 'antigravity') {
    const parsed = parseAntigravityRel(parts);
    return parsed ? statRef('antigravity', root, rel, parsed.providerId, null, parsed.product) : null;
  }
  return null;
}

function parseAntigravityRel(parts) {
  let product = null;
  let rest = parts;
  if (parts.length === 6 && ANTIGRAVITY_PRODUCTS.includes(parts[0])) {
    product = parts[0];
    rest = parts.slice(1);
  }
  if (rest.length !== 5) return null;
  const [brainDir, convId, sysDir, logsDir, fileName] = rest;
  if (brainDir !== 'brain' || !convId || sysDir !== '.system_generated' || logsDir !== 'logs') return null;
  if (fileName !== 'transcript_full.jsonl' && fileName !== 'transcript.jsonl') return null;
  return { providerId: convId, product };
}

export function claudeSessionFiles({ root = CLAUDE_ROOT } = {}) {
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, p.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // 只认这一层的 *.jsonl；<sessionId>/subagents/ 是子 agent 追踪，不是会话
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const rel = path.join(p.name, e.name);
      out.push(statRef('claude', root, rel, e.name.replace(/\.jsonl$/, ''), null, p.name));
    }
  }
  return out;
}

export function codexRolloutFiles({ root = CODEX_ROOT } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const parsed = parseRolloutName(e.name);
        if (!parsed) continue;
        const rel = path.relative(root, full);
        out.push(statRef('codex', root, rel, parsed.threadId, parsed.rolloutId, null));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 枚举 Antigravity 会话日志：`~/.gemini/<product>/brain/<uuid>/.system_generated/logs/transcript_full.jsonl`
 * （若尚未生成完整版则退回 `transcript.jsonl`）。同时也支持直接传入单个 product 根目录。
 */
export function antigravitySessionFiles({ root = GEMINI_ROOT } = {}) {
  const out = [];
  if (!root) return out;
  const scanProduct = (prefix) => {
    const brainRoot = path.join(root, ...prefix, 'brain');
    let convs;
    try {
      convs = fs.readdirSync(brainRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const product = prefix[0] ?? 'antigravity';
    for (const c of convs) {
      if (!c.isDirectory()) continue;
      const logsRel = path.join(...prefix, 'brain', c.name, '.system_generated', 'logs');
      const fullRel = path.join(logsRel, 'transcript_full.jsonl');
      const compactRel = path.join(logsRel, 'transcript.jsonl');
      let pickedRel = null;
      try {
        if (fs.statSync(path.join(root, fullRel)).isFile()) pickedRel = fullRel;
      } catch {
        // 完整版不在
      }
      if (!pickedRel) {
        try {
          if (fs.statSync(path.join(root, compactRel)).isFile()) pickedRel = compactRel;
        } catch {
          // 紧凑版也不在
        }
      }
      if (pickedRel) out.push(statRef('antigravity', root, pickedRel, c.name, null, product));
    }
  };
  for (const product of ANTIGRAVITY_PRODUCTS) scanProduct([product]);
  scanProduct([]);
  return out;
}
