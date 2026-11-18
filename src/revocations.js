import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
 * 每次查询先比一下文件的 mtime，变了才重读：命令行脚本改了表，守护进程不用重启就生效。
 * 写用「写临时文件再 rename」，半截文件不会出现。
 *
 * 文件坏了（不是合法 JSON）时**按空表处理并在日志里喊一声**，而不是拒绝所有人：
 * 后者会把 owner 自己锁在门外，而他修这个文件的唯一入口可能正是手机。
 */
function parseRevocationsJson(text) {
  const raw = JSON.parse(text);
  return {
    devices: raw && typeof raw.devices === 'object' && raw.devices && !Array.isArray(raw.devices)
      ? { ...raw.devices }
      : {},
    legacy: Array.isArray(raw?.legacy) ? raw.legacy.map(String) : [],
  };
}

export function fileRevocations(file) {
  let state = { devices: {}, legacy: [] };
  let seen = -1;
  let loadedOnce = false;

  const hasEntries = (s) => Object.keys(s.devices).length > 0 || s.legacy.length > 0;

  function load() {
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch (err) {
      // Only clear if the file genuinely does not exist; retain loaded revocations on transient stat errors.
      if (err?.code === 'ENOENT') {
        if (seen !== 0) state = { devices: {}, legacy: [] };
        seen = 0;
        loadedOnce = false;
      }
      return;
    }
    if (mtime === seen) return;
    try {
      state = parseRevocationsJson(fs.readFileSync(file, 'utf8'));
      seen = mtime;
      loadedOnce = true;
    } catch (e) {
      // Cold-start corrupt file degrades to empty table so owner can recover; once valid revocations
      // have been loaded, retain the in-memory set rather than failing open on mid-write corruption.
      console.error(`[baton] ${file} 读不懂：${e.message}`);
      if (!loadedOnce || !hasEntries(state)) {
        state = { devices: {}, legacy: [] };
        seen = mtime;
      }
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let mergedDevices = { ...state.devices };
    const mergedLegacy = new Set(state.legacy);
    try {
      const onDisk = parseRevocationsJson(fs.readFileSync(file, 'utf8'));
      mergedDevices = { ...onDisk.devices, ...mergedDevices };
      for (const id of onDisk.legacy) mergedLegacy.add(id);
    } catch {
      // Ignore missing or unreadable disk file before merging new state.
    }
    state = { devices: mergedDevices, legacy: [...mergedLegacy] };
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    loadedOnce = true;
    seen = -1; // Re-stat on next query so sub-millisecond writes are not skipped.
  }

  return {
    isRevoked(deviceId) {
      load();
      return Object.hasOwn(state.devices, deviceId);
    },
    isLegacyRevoked(principalId) {
      load();
      return state.legacy.includes(principalId);
    },
    revoke(deviceId, principalId) {
      load();
      if (Object.hasOwn(state.devices, deviceId)) return;
      state.devices[deviceId] = { principal: principalId, at: new Date().toISOString() };
      save();
    },
    revokeLegacy(principalId) {
      load();
      if (state.legacy.includes(principalId)) return false;
      state.legacy.push(principalId);
      save();
      return true;
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
    revoke: (id, pid) => { devices.set(id, pid); },
    revokeLegacy: (pid) => { const had = legacy.has(pid); legacy.add(pid); return !had; },
  };
}
