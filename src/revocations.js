import fs from 'node:fs';
import { withJsonWriteLock, writeJsonAtomic } from './json-store.js';

/**
 * 被吊销的设备凭据，落在 ~/.baton/revoked.json。
 *
 * ## 为什么要有这张表
 *
 * 配对下发的凭据原来是 `HMAC(token, 身份)`——**同一身份的所有设备拿到的是同一个值**，
 * 服务端也不记任何会话。于是「解除配对」只能清掉浏览器里那份 cookie；原生 App 存在
 * Keychain 里的 bearer、或者被人拷走的 cookie，服务端照收不误。手机丢了、点了解除，
 * 那个值其实还活着。
 *
 * 现在每次配对铸一个**带设备号**的凭据（见 http/auth.js 的 `d1.`），它仍然是无状态可验的
 * （设备号 + HMAC），只是多了一张「这些设备号作废了」的黑名单。表里只有被点过解除的设备，
 * 正常设备永远不进来——所以它很小，也不会在升级时把谁误踢掉。
 *
 * ## 两种条目
 *
 *   devices  设备号 → { principal, at }。/api/unpair 拿着自己的凭据来时写进去。
 *   legacy   身份 id 列表。列进来的身份，**升级前那种共用凭据**一律不认了——
 *            那种凭据分不出是哪台设备，要断就只能整个身份一起断（npm run revoke-legacy）。
 *
 * ## 读写
 *
 * CLI 与守护进程共用原有 JSON 格式。写入者通过 SQLite 事务取进程间互斥锁，
 * 在锁内重读、修改并原子替换账本。写入进程意外退出时，系统会释放锁。
 * 旧版本仍能读写这个 JSON；并发写入需要各写入端都使用此锁。
 * 首次发现或成功写入账本时留下持久标记。以后缺表时，重启后的进程也会暂停派生凭据。
 */
function parseRevocationsJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('吊销表不是有效的 JSON。');
  }
  if (!raw?.devices || typeof raw.devices !== 'object' || Array.isArray(raw.devices)
    || !Array.isArray(raw.legacy) || raw.legacy.some((id) => typeof id !== 'string')) {
    throw new Error('吊销表必须含有 devices 对象和 legacy 身份数组。');
  }
  if (Object.values(raw.devices).some((entry) => typeof entry?.principal !== 'string' || typeof entry?.at !== 'string')) {
    throw new Error('设备吊销记录缺少身份或日期。');
  }
  return raw;
}

export function fileRevocations(file) {
  const empty = { devices: {}, legacy: [] };
  const marker = file + '.initialized';
  let sawLedger = false;
  let cachedText = null;
  let cachedState = empty;
  let reportedError = false;

  function rememberLedger() {
    if (sawLedger) return;
    try { fs.writeFileSync(marker, '1\n', { flag: 'wx', mode: 0o600, flush: true }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    sawLedger = true;
  }

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' && !sawLedger && !fs.lstatSync(marker, { throwIfNoEntry: false })) return empty;
      throw err;
    }
    rememberLedger();
    // 相同 mtime 的替换也要生效；表很小，按原文复用已解析的快照。
    if (text !== cachedText) {
      cachedState = parseRevocationsJson(text);
      cachedText = text;
    }
    reportedError = false;
    return cachedState;
  }

  function checkedLedger() {
    try {
      return load();
    } catch (err) {
      if (!reportedError) {
        console.error(`[baton] ${file} 无法验证，已暂停设备和旧凭据。请修复或恢复吊销表。`, err.message);
        reportedError = true;
      }
      return null;
    }
  }

  function update(change) {
    return withJsonWriteLock(file, () => {
      const next = change(load());
      if (!next) return false;
      const text = writeJsonAtomic(file, next);
      rememberLedger();
      cachedText = text;
      cachedState = next;
      return true;
    });
  }

  return {
    isRevoked(deviceId) {
      const state = checkedLedger();
      return !state || Object.hasOwn(state.devices, deviceId);
    },
    isLegacyRevoked(principalId) {
      const state = checkedLedger();
      return !state || state.legacy.includes(principalId);
    },
    revoke(deviceId, principalId) {
      return update((state) => {
        if (Object.hasOwn(state.devices, deviceId)) return null;
        const entry = { principal: principalId, at: new Date().toISOString() };
        return { ...state, devices: { ...state.devices, [deviceId]: entry } };
      });
    },
    revokeLegacy(principalId) {
      return update((state) => {
        if (state.legacy.includes(principalId)) return null;
        return { ...state, legacy: [...state.legacy, principalId] };
      });
    },
  };
}

/** 只活在内存里的那份：测试用，也是 createAuth 不传时的默认值（行为同「没有吊销表」）。 */
export function memoryRevocations() {
  const devices = new Map();
  const legacy = new Set();
  return {
    isRevoked: (id) => devices.has(id),
    isLegacyRevoked: (pid) => legacy.has(pid),
    revoke(id, pid) {
      if (devices.has(id)) return false;
      devices.set(id, pid);
      return true;
    },
    revokeLegacy: (pid) => { const had = legacy.has(pid); legacy.add(pid); return !had; },
  };
}
