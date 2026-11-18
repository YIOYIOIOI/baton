import { create } from 'zustand';
import { fetch as expoFetch } from 'expo/fetch';
import { createClient, type Client } from '../api/client';
import { HEARTBEAT_MS, STALE_AFTER_MS } from '../api/classify';
import type { LinkAxis } from '../api/types';
import { clearToken, loadCredentials, normalizeBaseUrl, saveBaseUrl, saveToken } from './credentials';

/**
 * 网页端当前页面的来源；原生端没有这个概念，返回 null。
 *
 * 有它就意味着「这个页面是 Baton 自己发的」——地址已经确定，配对页不该再问一遍。
 * 原生端拿不到它，所以那边必须让用户输一次地址：app 不知道要连哪台电脑。
 */
export function pageOrigin(): string | null {
  const o = (globalThis as { location?: { origin?: string } }).location?.origin;
  return o && /^https?:/.test(o) ? o : null;
}

/**
 * 连接与凭据。
 *
 * `lastHeardAt` 是整个界面诚实性的锚：秒表、活动块、「在跑」这些都由它决定
 * 可不可信。任何一次收到服务器的字节（包括注释心跳）都要刷新它——
 * **不是**收到有内容的事件才刷新，否则一个安静但活着的轮次会被误判成断线。
 */

type State = {
  ready: boolean;          // 是否已从 Keychain 读回凭据
  baseUrl: string | null;
  token: string | null;
  link: LinkAxis;
  lastHeardAt: number;
  client: Client | null;

  boot: () => Promise<void>;
  pair: (baseUrl: string, code: string) => Promise<void>;
  unpair: () => Promise<void>;
  heard: () => void;
  setLink: (l: LinkAxis) => void;
  probe: () => Promise<boolean>;
};

function build(baseUrl: string | null, token: string | null, set: (p: Partial<State>) => void): Client | null {
  if (!baseUrl) return null;
  return createClient({
    baseUrl,
    token,
    onHeard: () => set({ lastHeardAt: Date.now() }),
    onLink: (link) => set({ link }),
  });
}

export const useConnection = create<State>((set, get) => ({
  ready: false,
  baseUrl: null,
  token: null,
  link: 'ok',
  lastHeardAt: 0,
  client: null,

  async boot() {
    // ready 必须无论如何都置 true。任何一处抛错就让它停在 false 的话，
    // 界面会永远转圈——那正是 Baton 立项要消灭的那种失败，不能自己先犯一遍。
    // 读不到凭据的后果只是「需要重新配对」，是可恢复的；永远转圈不是。
    try {
      const saved = await loadCredentials();
      // 网页版跑在 Baton 自己发的页面上，地址就是当前 origin——
      // 还要用户手打一遍是没道理的。原生端没有 origin，只能靠存的那个。
      const baseUrl = saved.baseUrl ?? pageOrigin();
      set({ baseUrl, token: saved.token, client: build(baseUrl, saved.token, set) });
    } catch {
      const baseUrl = pageOrigin();
      set({ baseUrl, token: null, client: build(baseUrl, null, set) });
    } finally {
      set({ ready: true });
    }
  },

  /**
   * 「配没配对」以**服务端认不认**为准，不以本地存不存着一个字符串为准。
   *
   * 两者会不一致，而且是常态：网页端同源时浏览器会自动带上 cookie，
   * 那条 cookie 可能是更早版本的客户端留下的——服务端认，本地却没有 token。
   * 只看本地存储就会把一个其实已经配好的人扔回配对页。
   *
   * 反过来也成立：本地存着一个已经失效的 token，只看存储就会让他一直撞 401。
   */
  async probe() {
    const c = get().client;
    if (!c) return false;
    try {
      await c.health();
      return true;
    } catch {
      return false;
    }
  },

  /**
   * 配对。
   *
   * Baton 的配对码换的是一个 **cookie**，但 RN 里我们要的是 Bearer 凭据——
   * 两者在后端是同一个抽象（`authorize` 同时认 cookie 与 Bearer），所以这里
   * 走 cookie 拿不到可存的东西。改为：配对成功后把**服务端下发的 cookie 值**
   * 当作 Bearer 凭据存起来。
   *
   * 注意 cookie 值是由 token 派生的 HMAC，不是 token 本身——存它比存 token
   * 更好：泄漏了只能访问 HTTP 接口，拿不到原始 token。
   */
  async pair(rawUrl: string, code: string) {
    const baseUrl = normalizeBaseUrl(rawUrl);
    if (!baseUrl) throw new Error('地址看不懂。形如 https://baton.example.com');

    const probe = createClient({
      baseUrl,
      token: null,
      onHeard: () => set({ lastHeardAt: Date.now() }),
      onLink: (link) => set({ link }),
    });
    const value = await probe.pairForBearer(code);

    await saveBaseUrl(baseUrl);
    await saveToken(value);
    set({ baseUrl, token: value, client: build(baseUrl, value, set) });
  },

  /**
   * 解除配对。**服务端那一步不能省。**
   *
   * 上一版只有 `clearToken()`——清的是本地存储。但浏览器里真正让服务端认人的是
   * HttpOnly cookie，JS 碰不到它，服务端也照收不误。于是「解除配对」点完看着像
   * 退出了，一回到首页又自动登回去。owner 实测：解除后点「配对」，
   * 不输码直接就恢复了。**那等于这个按钮在撒谎。**
   *
   * 所以先请服务端把 cookie 作废，再清本地。顺序不能反：先清本地的话，
   * 万一网络请求失败，本地已经没了凭据、cookie 却还在，用户就卡在
   * 「看着没配对、其实还连着」里出不来。
   */
  async unpair() {
    const { baseUrl, token } = get();
    if (baseUrl) {
      try {
        // 原生端的凭据是 bearer（存在 Keychain，不是 cookie）。带上它，服务端才能把这张
        // 设备凭据写进吊销表——只删本地那份的话，值本身还活着，被拷走就还能用。
        await expoFetch(`${baseUrl}/api/unpair`, {
          method: 'POST',
          credentials: 'include',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
      } catch {
        // 网络失败也要继续清本地：至少这台设备上不再留凭据。
        // cookie 可能还在，下次联网时用户再点一次就清掉了。
      }
    }
    await clearToken();
    set({ token: null, client: build(baseUrl, null, set) });
  },

  heard: () => set({ lastHeardAt: Date.now() }),
  setLink: (link) => set({ link }),
}));

export { HEARTBEAT_MS, STALE_AFTER_MS };
