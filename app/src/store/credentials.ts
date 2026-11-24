import { deleteSecret, getSecret, setSecret } from './secure';
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';

/**
 * 配对凭据的存放。后端实现按平台分叉，见 `secure.ts`。
 */

const K_TOKEN = 'baton.token';
const K_BASE = 'baton.baseUrl';
const K_NATIVE = 'baton.connection';
const K_PENDING = 'baton.pendingUnpair';

export type NativeCredential = { baseUrl: string; token: string };

function fallbackLock() {
  return new File(Paths.document, 'baton-unpair-pending');
}

export async function loadCredentials(): Promise<{ baseUrl: string | null; token: string | null; pending?: NativeCredential; storageError?: boolean }> {
  if (Platform.OS === 'web') {
    await deleteSecret(K_TOKEN);
    return { baseUrl: null, token: null };
  }
  const legacyPending = await getSecret(K_PENDING, true);
  if (legacyPending) {
    const pending: NativeCredential = JSON.parse(legacyPending);
    return { baseUrl: pending.baseUrl, token: null, pending };
  }
  const bound = await getSecret(K_NATIVE, true);
  if (bound) {
    const record = JSON.parse(bound) as NativeCredential & { state?: 'pending' };
    if (record.state === 'pending') return { baseUrl: record.baseUrl, token: null, pending: record };
    if (fallbackLock().exists) return { baseUrl: record.baseUrl, token: null, pending: record, storageError: true };
    return record;
  }
  const [baseUrl, token] = await Promise.all([getSecret(K_BASE, true), getSecret(K_TOKEN, true)]);
  if (baseUrl && token && fallbackLock().exists) {
    return { baseUrl, token: null, pending: { baseUrl, token }, storageError: true };
  }
  return { baseUrl, token };
}

export const saveBaseUrl = (baseUrl: string) => setSecret(K_BASE, baseUrl);
export async function saveNativeCredential(baseUrl: string, token: string) {
  await clearPendingUnpair();
  await setSecret(K_NATIVE, JSON.stringify({ baseUrl, token }));
  await deleteSecret(K_TOKEN);
  await saveBaseUrl(baseUrl);
}

export async function savePendingUnpair(pending: NativeCredential) {
  try {
    // A restart sees either an active credential or the same credential restricted to revocation.
    await setSecret(K_NATIVE, JSON.stringify({ ...pending, state: 'pending' }));
  } catch {
    try { await setSecret(K_PENDING, JSON.stringify(pending)); }
    catch (error) {
      // This file contains no credential. Its presence restricts the Keychain
      // copy to revocation even if Keychain updates and deletions are unavailable.
      try {
        const guard = fallbackLock();
        if (!guard.exists) guard.create();
      } catch { await clearToken(); }
      throw error;
    }
  }
}
export async function clearPendingUnpair() {
  await deleteSecret(K_PENDING, true);
  const guard = fallbackLock();
  if (guard.exists) guard.delete();
}

/** 解除配对。baseUrl 留着——用户多半还要连同一台电脑，让他重打一遍地址是刁难。 */
export const clearToken = () => Promise.all([deleteSecret(K_TOKEN, true), deleteSecret(K_NATIVE, true)]);

/**
 * 规范化用户输入的地址。
 *
 * 手机上打 URL 极易出错，而错法就那么几种，全都能自动修：
 * 忘了协议、多了尾斜杠、被输入法加了空格、被自动首字母大写。
 * 不修的话用户只会看到一个「连不上」，然后无从下手。
 */
export function normalizeBaseUrl(input: string): string | null {
  let s = input.trim().replace(/\s+/g, '');
  if (!s) return null;
  if (s.includes('\\') || (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s))) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname || u.username || u.password) return null;
    // 只保留协议 + 主机 + 端口；路径/查询/锚点一律丢掉——
    // 从浏览器复制过来时常带着 /#/xxx，留着会让每个请求都 404
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
