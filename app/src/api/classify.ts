import type { LinkAxis } from './types';

/**
 * 传输轴判别。
 *
 * 这是整个客户端最容易骗人的一块：五种失败在用户眼里长得很像，但该做的事完全不同。
 *
 *   offline      手机没网         →  等一下，或换个网络
 *   origin       电脑睡了/baton 挂了 →  去把电脑叫醒
 *   intercepted  中途被拦          →  多半是公司网的登录页，去浏览器登一下
 *   retrying     暂时抖动          →  什么都不用做
 *   ok           好着呢
 *
 * 把它们压成一个"连不上"，用户就只能瞎试。这正是原型里"两根正交的轴"要解决的。
 *
 * 判据来自实测，不是猜的：
 * - Baton 的每个响应都带 `X-Baton: 1`（含静态资源、SSE、404）。**没有这个头
 *   就说明回话的不是 Baton**——公司网的强制门户会拿任意 HTML 回 200。
 * - Cloudflare 在源站不应答时回 502 / 521–524 / 530，且带 `cf-ray`。
 * - fetch 直接抛异常 = 一个字节都没出去 = 手机没网。
 */

export type Probe =
  | { networkError: true }
  | {
      networkError?: false;
      status: number;
      /** 响应头取值函数，大小写不敏感（fetch 的 Headers 本身就是） */
      header: (name: string) => string | null;
      /** fetch 的 response.type，用于识别不透明重定向 */
      type?: string;
    };

const ORIGIN_DOWN = new Set([502, 521, 522, 523, 524, 530]);

export function classifyProbe(p: Probe): LinkAxis {
  // 请求根本没发出去
  if (p.networkError) return 'offline';

  // 不透明重定向：有东西把请求导去了别处。RN 的 fetch 会静默跟随 302，
  // 所以这一支在 RN 上多半不会命中——但在 web target 上会，留着不亏。
  if (p.type === 'opaqueredirect') return 'intercepted';
  if (p.status >= 300 && p.status < 400) return 'intercepted';

  const isBaton = p.header('x-baton') === '1';
  if (isBaton) {
    // 话是 Baton 自己说的，连接就是通的。401 属于「没配对」，由认证层处理，
    // 不是传输问题——这两件事混在一起会让「重新配对」和「等网络」互相盖住。
    return 'ok';
  }

  // 到这里：有响应，但不是 Baton 回的
  const cfRay = p.header('cf-ray');
  if (ORIGIN_DOWN.has(p.status)) {
    // 带 cf-ray 才能确定是 Cloudflare 在替源站回话；不带则可能是别的中间设备
    return cfRay ? 'origin' : 'intercepted';
  }

  // 200 但没有 X-Baton —— 典型的强制门户
  if (p.status >= 200 && p.status < 300) return 'intercepted';

  // 其余（4xx/5xx 且不带 X-Baton）：说不准是谁回的，按暂时故障处理并重试。
  // 不猜，是因为猜错会把用户引向错误的动作。
  return 'retrying';
}

/** 从一个真实 Response 构造探针。 */
export function probeOf(res: Response): Probe {
  return {
    status: res.status,
    header: (n) => res.headers.get(n),
    type: (res as unknown as { type?: string }).type,
  };
}

/**
 * 秒表活性：连着 N 个心跳周期没听到服务器，就该把秒表冻住变灰。
 *
 * 阈值定 2 个周期（30 秒）：1 个周期太敏感——一次 GC 或一次移动网络切换就会
 * 误报「连接已死」，而误报比晚报更糟，它会让用户不敢相信这个指示器。
 */
export const HEARTBEAT_MS = 15_000;
export const STALE_AFTER_MS = HEARTBEAT_MS * 2;

export function isStopwatchStale(lastHeardAt: number, now: number): boolean {
  return now - lastHeardAt > STALE_AFTER_MS;
}
