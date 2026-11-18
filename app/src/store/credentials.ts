import { deleteSecret, getSecret, setSecret } from './secure';

/**
 * 配对凭据的存放。后端实现按平台分叉，见 `secure.ts`。
 */

const K_TOKEN = 'baton.token';
const K_BASE = 'baton.baseUrl';

export async function loadCredentials(): Promise<{ baseUrl: string | null; token: string | null }> {
  const [baseUrl, token] = await Promise.all([getSecret(K_BASE), getSecret(K_TOKEN)]);
  return { baseUrl, token };
}

export const saveBaseUrl = (baseUrl: string) => setSecret(K_BASE, baseUrl);
export const saveToken = (token: string) => setSecret(K_TOKEN, token);

/** 解除配对。baseUrl 留着——用户多半还要连同一台电脑，让他重打一遍地址是刁难。 */
export const clearToken = () => deleteSecret(K_TOKEN);

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
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    // 只保留协议 + 主机 + 端口；路径/查询/锚点一律丢掉——
    // 从浏览器复制过来时常带着 /#/xxx，留着会让每个请求都 404
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
