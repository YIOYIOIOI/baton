import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATON_DIR } from '../config.js';
import { normPath } from '../scope.js';
import { pidAlive } from '../runtime/live.js';
import { readRegistration, registryDirectory } from '../../sidecars/baton-bridge/sidecars/bridge/registry.mjs';
import {
  healthProof, isNonce, LOOPBACK, matchesProof, MAX_BODY, newNonce, PROTOCOL, requestHeaders, responseProof,
} from '../../sidecars/baton-bridge/sidecars/bridge/protocol.mjs';

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

// Only handles returned after a successful challenge can dispatch. The secret never
// travels over HTTP and is absent from serializable session or diagnostic data.
const verified = new WeakMap();

function exchange(instance, pathname, { method = 'GET', data = '', nonce = null, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: LOOPBACK, family: 4, port: instance.port, path: pathname, method,
      headers: nonce ? {
        ...requestHeaders(instance, pathname, data, nonce),
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
      } : {},
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) res.destroy(new Error('Antigravity 桥接服务回执过大'));
        else chunks.push(chunk);
      });
      res.on('error', rejectTransport);
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (nonce && !matchesProof(responseProof(instance, nonce, res.statusCode, raw), res.headers['x-baton-proof'])) {
          return rejectTransport(new Error('无法验证 Antigravity 桥接服务的调用回执'));
        }
        let parsed;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          return rejectTransport(new Error('Antigravity 桥接服务回执格式无效'));
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed?.ok === true && parsed.delivery === undefined) {
          return resolve(parsed);
        }
        const error = new Error(typeof parsed?.error === 'string' ? parsed.error : 'bridge HTTP ' + res.statusCode);
        if (nonce && res.statusCode >= 400 && res.statusCode < 600 && parsed?.ok === false && parsed.delivery === 'not_dispatched') {
          return reject(error);
        }
        rejectTransport(error);
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Antigravity 桥接服务响应超时')), timeoutMs);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    function rejectTransport(error) {
      if (method === 'POST' && req.writableFinished) error.deliveryUnknown = true;
      reject(error);
    }
    req.on('error', rejectTransport);
    req.end(data || undefined);
  });
}

export async function callBridge(bridge, pathname, { method = 'POST', body = null, timeoutMs = 15_000 } = {}) {
  const instance = verified.get(bridge);
  if (!instance || method !== 'POST') throw new Error('Antigravity 桥接实例尚未通过验证');
  const data = JSON.stringify(body ?? {});
  if (Buffer.byteLength(data) > MAX_BODY) throw new Error('Antigravity 桥接请求体过大');
  return exchange(instance, pathname, { method, data, nonce: newNonce(), timeoutMs });
}

/**
 * 发现当前本机存活的 `baton-bridge` Sidecar 实例，并做一次 `/health` 探活。
 * @param {{ batonDir?: string, projectId?: string | null, alive?: (pid: unknown) => boolean }} [opts]
 */
export async function findLiveBridge({ batonDir = BATON_DIR, projectId = null, alive = pidAlive } = {}) {
  let dir;
  let names = [];
  try {
    dir = registryDirectory(batonDir);
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw;
    try {
      raw = readRegistration(file);
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(raw?.pid) || raw.pid <= 0 || name !== raw.pid + '.json') continue;
    if (!alive(raw.pid)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // 清理陈旧登记文件失败可忽略
      }
      continue;
    }
    // Running v1 sidecars upgrade on the next desktop restart. Never probe them with the owner token.
    if (raw.protocol !== PROTOCOL || raw.host !== LOOPBACK || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535
        || !isNonce(raw.secret) || typeof raw.instanceId !== 'string' || !/^[0-9a-f-]{36}$/.test(raw.instanceId)
        || !(typeof raw.projectId === 'string' || raw.projectId === null)) continue;
    candidates.push(raw);
  }

  candidates.sort((a, b) => {
    const aHit = projectId && a.projectId === projectId ? 1 : 0;
    const bHit = projectId && b.projectId === projectId ? 1 : 0;
    return bHit - aHit || String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''));
  });

  for (const c of candidates) {
    try {
      const challenge = newNonce();
      const health = await exchange(c, '/health?challenge=' + challenge, { timeoutMs: 2000 });
      if (health.protocol !== PROTOCOL || health.instanceId !== c.instanceId || health.pid !== c.pid
          || health.projectId !== c.projectId || !matchesProof(healthProof(c, challenge), health.proof)) continue;
      const handle = Object.freeze({ pid: c.pid, port: c.port, projectId: c.projectId, instanceId: c.instanceId });
      verified.set(handle, c);
      return handle;
    } catch {
      // 该实例连不上，看下一个
    }
  }
  return null;
}
