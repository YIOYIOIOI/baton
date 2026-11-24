import fs from 'node:fs';
import { withJsonWriteLock, writeJsonAtomic } from './json-store.js';

const TOUCH_INTERVAL_MS = 60_000;

/**
 * Parse a User-Agent header into concise non-sensitive UI labels (`label` and `platform`).
 * Raw UA strings and client IP addresses are intentionally discarded so disk state stays minimal.
 * @param {string | undefined | null} uaHeader
 * @returns {{ label: string, platform: string }}
 */
export function parseDeviceAgent(uaHeader) {
  const ua = String(uaHeader ?? '').trim();
  if (!ua) return { label: 'Paired Device', platform: 'Unknown' };
  if (/^Baton\//i.test(ua) || /Expo/i.test(ua)) {
    const plat = /Android/i.test(ua) ? 'Android' : 'Mobile';
    return { label: 'Baton App', platform: plat };
  }
  let platform = 'Desktop';
  if (/iPhone/i.test(ua)) platform = 'iPhone';
  else if (/iPad/i.test(ua)) platform = 'iPad';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) platform = 'macOS';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Linux/i.test(ua)) platform = 'Linux';

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/CriOS|Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/FxiOS|Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  else if (/curl|node/i.test(ua)) browser = 'CLI';

  return {
    label: browser ? `${platform} · ${browser}` : `${platform} Device`,
    platform,
  };
}

function createDeviceStore(read, update) {
  return {
    register({ deviceId, principalId, generation = null, userAgent = '', now = Date.now() }) {
      if (!deviceId) return null;
      const { label, platform } = parseDeviceAgent(userAgent);
      const entry = {
        id: deviceId,
        principalId: String(principalId),
        ...(generation ? { generation } : {}),
        label,
        platform,
        createdAt: now,
        lastSeenAt: now,
      };
      update((devices) => { devices[deviceId] = entry; return true; });
      return entry;
    },

    touch(deviceId, now = Date.now()) {
      if (!deviceId) return false;
      const due = (entry) => entry && now - entry.lastSeenAt >= TOUCH_INTERVAL_MS;
      if (!due(read()[deviceId])) return false;
      try {
        return update((devices) => {
          if (!due(devices[deviceId])) return false;
          devices[deviceId] = { ...devices[deviceId], lastSeenAt: now };
          return true;
        });
      } catch { return false; } // lastSeen bookkeeping must not invalidate a signed credential.
    },

    get(deviceId) {
      const devices = read();
      return Object.hasOwn(devices, deviceId) ? devices[deviceId] : null;
    },

    list({ principalId = null } = {}) {
      const all = Object.values(read());
      const filtered = principalId ? all.filter((d) => d.principalId === principalId) : all;
      return filtered.sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
    },

    remove(deviceId) {
      return update((devices) => {
        if (!Object.hasOwn(devices, deviceId)) return false;
        delete devices[deviceId];
        return true;
      });
    },
  };
}

/**
 * File-backed connected devices registry stored with mode 0600 and atomic temp+rename writes.
 * @param {string} file
 */
export function fileDevices(file) {
  let snapshot = {};
  let previousText = null;
  let sawFile = false;
  let reported = false;
  function read(strict = false) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      sawFile = true;
      if (text !== previousText) {
        const devices = JSON.parse(text)?.devices;
        if (!devices || typeof devices !== 'object' || Array.isArray(devices)
          || Object.entries(devices).some(([id, row]) => row?.id !== id || typeof row.principalId !== 'string'
            || typeof row.label !== 'string' || typeof row.platform !== 'string'
            || (row.generation !== undefined && (typeof row.generation !== 'string' || !row.generation))
            || !Number.isFinite(row.lastSeenAt) || !Number.isFinite(row.createdAt))) throw new Error('设备清单格式无效');
        snapshot = devices;
        previousText = text;
      }
      reported = false;
    } catch (err) {
      if (err.code === 'ENOENT' && !sawFile) return snapshot;
      if (!reported) console.error(`[baton] ${file} 无法验证，请恢复设备清单。`);
      reported = true;
      if (strict) throw new Error('无法安全更新设备清单，请先恢复文件。', { cause: err });
    }
    return snapshot;
  }
  return createDeviceStore(read, (change) => withJsonWriteLock(file, () => {
    const next = { ...read(true) };
    if (!change(next)) return false;
    previousText = writeJsonAtomic(file, { devices: next });
    snapshot = next;
    sawFile = true;
    return true;
  }));
}

/** In-memory device registry for isolated tests and ephemeral runs. */
export function memoryDevices() {
  const devices = {};
  return createDeviceStore(() => devices, (change) => change(devices));
}
