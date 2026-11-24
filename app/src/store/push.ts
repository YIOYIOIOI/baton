import { Platform } from 'react-native';
import type { Client } from '../api/client';

/**
 * 网页推送的订阅流程。
 *
 * iOS 上有一条硬规矩：**只有「添加到主屏」之后的 PWA 才能用推送**，
 * Safari 标签页里连 `Notification` 都不存在。所以这里要能分辨出
 * 「不支持」和「还没加到主屏」——两者的提示完全不同，前者没救，
 * 后者只差一步操作。
 *
 * 另一条：`Notification.requestPermission()` 必须由用户手势触发。
 * 页面加载时自动调，浏览器会直接拒掉，且不给任何提示。
 */

export type PushState =
  | 'unsupported'      // 这个浏览器/平台不支持
  | 'needs-homescreen' // iOS Safari 标签页里——加到主屏才能用
  | 'denied'           // 用户拒过，只能去系统设置里改
  | 'off'              // 支持但还没订
  | 'on';

type W = typeof globalThis & {
  Notification?: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> };
  navigator?: Navigator & { standalone?: boolean };
  matchMedia?: (q: string) => { matches: boolean };
};

const w = globalThis as W;

/** 是不是以独立应用的形态在跑（加到主屏 / 安装过）。 */
function standalone(): boolean {
  if (w.navigator?.standalone) return true; // iOS 的判据
  try {
    return !!w.matchMedia?.('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

export function pushState(): PushState {
  if (Platform.OS !== 'web') return 'unsupported'; // 原生端将来走 APNs，不是这套
  if (!w.navigator?.serviceWorker || !('PushManager' in w)) {
    // iOS 上主屏之外就是这个分支：PushManager 压根不存在
    return standalone() ? 'unsupported' : 'needs-homescreen';
  }
  if (!w.Notification) return 'unsupported';
  if (w.Notification.permission === 'denied') return 'denied';
  if (w.Notification.permission === 'granted') return 'on';
  return 'off';
}

export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (Platform.OS !== 'web' || !w.navigator?.serviceWorker) return null;
  try {
    return await w.navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

/** Upgrade an existing browser subscription after authentication without prompting for permission. */
export async function rebindExistingPush(client: Client, current: () => boolean): Promise<void> {
  if (pushState() !== 'on') return;
  const reg = await registerWorker();
  const sub = await reg?.pushManager?.getSubscription();
  if (sub && current()) await client.pushSubscribe(sub.endpoint);
}

/**
 * 开启推送。**必须在用户点击的回调里调**——权限请求需要用户手势，
 * 在别处调浏览器会直接拒，而且不给任何提示，查起来极费劲。
 */
export async function enablePush(client: Client): Promise<PushState> {
  const s = pushState();
  if (s !== 'off' && s !== 'on') return s;

  const reg = await registerWorker();
  if (!reg) return 'unsupported';

  const perm = await w.Notification!.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';

  const { publicKey } = await client.pushKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true, // iOS 只接受 true：收到推送必须显示通知
    applicationServerKey: publicKey,
  });
  await client.pushSubscribe(sub.endpoint);
  return 'on';
}

export async function disablePush(client: Client): Promise<PushState> {
  if (Platform.OS !== 'web' || !w.navigator?.serviceWorker) return 'unsupported';
  try {
    const reg = await w.navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await client.pushUnsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {
    // 退订失败不影响本地开关，服务端那条死订阅下次推送时会被 410 清掉
  }
  return 'off';
}

export const PUSH_HINT: Record<PushState, string> = {
  on: '跑完时通知。',
  off: '跑完时通知，不用一直盯着。',
  denied: '去系统设置里打开 Baton 的通知权限。',
  // 「iOS 只允许主屏应用发通知」这半句不能省：不说的话，用户会以为是 Baton
  // 坏了而不是系统限制，然后反复点这个开关
  'needs-homescreen': '先把页面添加到主屏幕——iOS 只允许主屏应用发通知。',
  unsupported: '这个浏览器不支持通知。',
};

const PUSH_HINT_EN: Record<PushState, string> = {
  on: 'Notifies when a turn finishes.',
  off: 'Get notified when turns finish instead of watching.',
  denied: 'Enable notification permissions for Baton in system settings.',
  'needs-homescreen': 'Add this page to your Home Screen first — iOS only allows Web Push for installed web apps.',
  unsupported: 'Notifications are not supported in this browser.',
};

export function pushHint(state: PushState, locale: 'en' | 'zh'): string {
  return locale === 'en' ? PUSH_HINT_EN[state] : PUSH_HINT[state];
}
