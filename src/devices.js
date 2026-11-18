import fs from 'node:fs';
import path from 'node:path';

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

function createDeviceStore(persist) {
  let state = { devices: {} };
  let dirty = false;

  const ensureLoaded = () => {
    const loaded = persist.load(state);
    if (loaded) state = loaded;
  };

  return {
    register({ deviceId, principalId, userAgent = '', now = Date.now() }) {
      if (!deviceId) return null;
      ensureLoaded();
      const { label, platform } = parseDeviceAgent(userAgent);
      const entry = {
        id: deviceId,
        principalId: String(principalId),
        label,
        platform,
        createdAt: now,
        lastSeenAt: now,
      };
      state.devices[deviceId] = entry;
      persist.save(state);
      dirty = false;
      return entry;
    },

    touch(deviceId, now = Date.now()) {
      if (!deviceId) return false;
      ensureLoaded();
      const entry = state.devices[deviceId];
      if (!entry) return false;
      if (now - Number(entry.lastSeenAt || 0) < TOUCH_INTERVAL_MS && !dirty) return false;
      entry.lastSeenAt = now;
      persist.save(state);
      dirty = false;
      return true;
    },

    get(deviceId) {
      ensureLoaded();
      return Object.hasOwn(state.devices, deviceId) ? state.devices[deviceId] : null;
    },

    list({ principalId = null } = {}) {
      ensureLoaded();
      const all = Object.values(state.devices);
      const filtered = principalId ? all.filter((d) => d.principalId === principalId) : all;
      return filtered.sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
    },

    remove(deviceId) {
      ensureLoaded();
      if (!Object.hasOwn(state.devices, deviceId)) return false;
      delete state.devices[deviceId];
      persist.save(state);
      dirty = false;
      return true;
    },
  };
}

/**
 * File-backed connected devices registry stored with mode 0600 and atomic temp+rename writes.
 * @param {string} file
 */
export function fileDevices(file) {
  let seen = -1;
  return createDeviceStore({
    load() {
      let mtime;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        if (seen !== 0) {
          seen = 0;
          return { devices: {} };
        }
        return null;
      }
      if (mtime === seen) return null;
      seen = mtime;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const devices = raw && typeof raw.devices === 'object' && raw.devices ? raw.devices : {};
        return { devices };
      } catch {
        return { devices: {} };
      }
    },
    save(state) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      seen = -1;
    },
  });
}

/** In-memory device registry for isolated tests and ephemeral runs. */
export function memoryDevices() {
  return createDeviceStore({
    load: () => null,
    save: () => {},
  });
}
