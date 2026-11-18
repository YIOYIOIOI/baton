import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATON_DIR } from '../config.js';
import { normPath } from '../scope.js';
import { pidAlive } from '../runtime/live.js';

export const DEFAULT_GEMINI_CONFIG = path.join(os.homedir(), '.gemini', 'config');
const BRIDGE_SOURCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'sidecars', 'baton-bridge',
);

function syncDir(srcDir, dstDir) {
  let changed = false;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      if (syncDir(src, dst)) changed = true;
    } else if (entry.isFile()) {
      const content = fs.readFileSync(src);
      let same = false;
      try {
        same = fs.readFileSync(dst).equals(content);
      } catch {
        same = false;
      }
      if (!same) {
        fs.writeFileSync(dst, content);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * 将仓库内官方 Antigravity Sidecar 插件 `sidecars/baton-bridge/` 同步至
 * `~/.gemini/config/plugins/baton-bridge/`。
 *
 * 按 `plugin/SKILL.md` 纪律：绝不触碰 `~/.gemini/config/config.json`，新插件放进
 * `plugins/` 后由 Antigravity 自动发现并默认启用。
 */
export function ensureAntigravityPlugin({
  geminiConfigDir = DEFAULT_GEMINI_CONFIG,
  sourceDir = BRIDGE_SOURCE_DIR,
} = {}) {
  if (!fs.existsSync(sourceDir)) return { destDir: null, changed: false };
  const destDir = path.join(geminiConfigDir, 'plugins', 'baton-bridge');
  const changed = syncDir(sourceDir, destDir);
  return { destDir, changed };
}

function toAntigravityFolderUri(dir) {
  const resolved = path.resolve(dir).replace(/[\\/]+$/, '');
  const posix = resolved.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}%3A`);
  return posix.startsWith('/') ? `file://${posix}` : `file:///${posix}`;
}

function fromFolderUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * 在 `~/.gemini/config/projects/*.json` 中按 `cwd` 匹配 Antigravity 的 `projectId`；
 * 匹配不到且 `createIfMissing` 为真时新建项目描述 JSON。
 */
export function resolveAntigravityProjectId(cwd, {
  geminiConfigDir = DEFAULT_GEMINI_CONFIG,
  createIfMissing = false,
} = {}) {
  if (!cwd) return null;
  const target = normPath(cwd);
  const projectsDir = path.join(geminiConfigDir, 'projects');
  let entries = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  let bestPrefixLen = -1;
  let bestId = null;

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(projectsDir, e.name), 'utf8'));
    } catch {
      continue;
    }
    if (typeof raw?.id !== 'string' || !raw.id) continue;
    const resources = Array.isArray(raw?.projectResources?.resources) ? raw.projectResources.resources : [];
    for (const r of resources) {
      const folderPath = fromFolderUri(r?.gitFolder?.folderUri);
      if (!folderPath) continue;
      const pNorm = normPath(folderPath);
      if (target === pNorm) return raw.id;
      if (target.startsWith(pNorm + path.sep) && pNorm.length > bestPrefixLen) {
        bestPrefixLen = pNorm.length;
        bestId = raw.id;
      }
    }
  }
  if (bestId) return bestId;
  if (!createIfMissing) return null;

  const id = crypto.randomUUID();
  const baseName = path.basename(path.resolve(cwd)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'workspace';
  const payload = {
    id,
    name: baseName,
    projectResources: {
      resources: [
        { gitFolder: { folderUri: toAntigravityFolderUri(cwd) } },
      ],
    },
    permissionGrants: { v2Migrated: true },
    settings: {},
    isWorkspaceOnly: false,
  };
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, `${id}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  return id;
}

function readToken(batonDir) {
  try {
    const t = fs.readFileSync(path.join(batonDir, 'token'), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

export function callBridge(bridge, pathname, { method = 'POST', body = null, token = bridge.token, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: bridge.host || '127.0.0.1',
      port: bridge.port,
      path: pathname,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          parsed = { raw };
        }
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300 && parsed?.ok !== false) {
          resolve(parsed);
        } else {
          reject(new Error(parsed?.error ?? `bridge HTTP ${res.statusCode}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Antigravity 桥接服务响应超时'));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 发现当前本机存活的 `baton-bridge` Sidecar 实例，并做一次 `/health` 探活。
 * @param {{ batonDir?: string, projectId?: string | null, alive?: (pid: unknown) => boolean }} [opts]
 */
export async function findLiveBridge({ batonDir = BATON_DIR, projectId = null, alive = pidAlive } = {}) {
  const dir = path.join(batonDir, 'antigravity-bridges');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const token = readToken(batonDir);
  if (!token) return null;

  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Number.isInteger(raw?.pid) || !Number.isInteger(raw?.port) || raw.port <= 0) continue;
    if (!alive(raw.pid)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // 清理陈旧登记文件失败可忽略
      }
      continue;
    }
    candidates.push({ ...raw, token });
  }

  candidates.sort((a, b) => {
    const aHit = projectId && a.projectId === projectId ? 1 : 0;
    const bHit = projectId && b.projectId === projectId ? 1 : 0;
    return bHit - aHit || String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''));
  });

  for (const c of candidates) {
    try {
      await callBridge(c, '/health', { method: 'GET', timeoutMs: 2000 });
      return c;
    } catch {
      // 该实例连不上，看下一个
    }
  }
  return null;
}
