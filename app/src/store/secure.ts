import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * 凭据存取的平台分支。
 *
 * **原生：Keychain。** 系统加密、卸载即清、别的应用读不到。这是原生相对 PWA 的
 * 实质优势之一，也是配对凭据该待的地方。
 *
 * Web 只用 localStorage 保存界面设置和配对状态。设备凭据由同源 HttpOnly cookie 保管。
 *
 * `SecureStore` 在 web 上不是"降级可用"，而是**函数根本不存在**——直接调用会
 * 同步抛 TypeError，连 `.catch` 都接不住（Promise 还没被创建）。所以必须在
 * 调用前按平台分叉，不能靠 try/catch 兜。
 */

const WEB = Platform.OS === 'web';

const OPTS: SecureStore.SecureStoreOptions = {
  // 不同步到 iCloud Keychain：配对是「这台手机 ↔ 那台电脑」的一次授权，
  // 同步到用户其他设备等于悄悄扩大了授权范围
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function getSecret(key: string, strict = false): Promise<string | null> {
  if (WEB) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null; // 隐私模式下 localStorage 会抛
    }
  }
  try {
    return await SecureStore.getItemAsync(key, OPTS);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (WEB) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // 存不进去就算了——web 只是开发时看渲染用的
    }
    return;
  }
  await SecureStore.setItemAsync(key, value, OPTS);
}

export async function deleteSecret(key: string, strict = false): Promise<void> {
  if (WEB) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* 同上 */
    }
    return;
  }
  try { await SecureStore.deleteItemAsync(key, OPTS); }
  catch (error) { if (strict) throw error; }
}

