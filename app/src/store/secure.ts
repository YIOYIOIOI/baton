import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * 凭据存取的平台分支。
 *
 * **原生：Keychain。** 系统加密、卸载即清、别的应用读不到。这是原生相对 PWA 的
 * 实质优势之一，也是配对凭据该待的地方。
 *
 * **Web：localStorage，并且明确承认它不安全。** web target 在这个项目里只有一个
 * 用途——Windows 上没法跑 iOS 模拟器，`expo start --web` 是唯一能真看到渲染的
 * 路径。拿它当"也能用的正式客户端"是自欺：localStorage 对同源脚本完全可读，
 * 一个 XSS 就能把凭据带走。所以这里不做任何"看起来也挺安全"的包装
 * （不加密、不混淆），宁可让它显眼地不安全，也不要让人误以为它安全。
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

export async function getSecret(key: string): Promise<string | null> {
  if (WEB) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null; // 隐私模式下 localStorage 会抛
    }
  }
  try {
    return await SecureStore.getItemAsync(key, OPTS);
  } catch {
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

export async function deleteSecret(key: string): Promise<void> {
  if (WEB) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* 同上 */
    }
    return;
  }
  await SecureStore.deleteItemAsync(key, OPTS).catch(() => {});
}

