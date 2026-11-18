/**
 * 网页端的触感。原生端走 expo-haptics（见 haptics.ts），这里只管浏览器。
 *
 * ## 浏览器里到底能做到什么（2026-11 查证）
 *
 *   Android Chrome   `navigator.vibrate(ms)`。能用，但只有「震多久」，没有强弱、没有
 *                    系统那几种手感；而且要页面先被点过一次（sticky activation）
 *   iOS Safari / PWA **没有 Vibration API**，从来没有（caniuse 到 27.2 都是不支持）。
 *                    唯一的系统触感来源是 Safari 17.4 加的 `<input type="checkbox" switch>`：
 *                    拨动它会有一下 Taptic 轻震
 *   桌面浏览器       不做。让整台电脑震一下是错的
 *
 * iOS 那条有过一次变化，决定了这里的写法：
 *
 *   17.4 – 26.4  在用户手势里 `label.click()` 拨一下隐藏的开关就会震（ios-haptics 早期做法）
 *   26.5 起      WebKit 修了 bug 309082：**只认真手指点到开关或它的 label**，脚本合成的
 *                click 一律不震
 *
 * 所以两条路都留着：
 *
 *   1. **覆盖层**（主路）：给带触感的可点元素铺一层透明 `<label>`，挂着一个隐藏的
 *      switch。手指落在 label 上 → 浏览器把这次真点击转给 switch → 系统震一下；点击照常
 *      冒泡到下面的按钮，动作不受影响。26.5 之后只有这条还管用。实现见 `HapticOverlay`
 *      （components/ui.tsx 的 Tappable 里挂）
 *   2. **程序化拨动**（兜底）：`fire()` 时如果最近 400ms 里没有覆盖层收到过真点击，
 *      就 `label.click()` 试一下。17.4–26.4 上会震，26.5+ 上被系统静默忽略，不报错
 *
 * ## 代价，说清楚
 *
 * - iOS 网页上**只有一种震感**：tap / thud / select / success / fail 摸起来都一样。
 *   原生那套「选择和按钮是两种震动」的区分在网页上做不到，没有公开 API
 * - 只有**手指点下去那一刻**能震：异步回来之后（发送成功、一轮跑完）、长按计时到点、
 *   拖动过程中，26.5+ 上都不会震。这些在网页上就是没有触感，靠界面本身的变化表达
 * - 覆盖层盖住了元素的子节点，所以只能挂在**叶子按钮**上，不能挂在里面还有别的
 *   可点东西的容器上
 *
 * 用户在系统设置里关掉「系统触感」时，switch 那一下也会跟着不震——这正是想要的。
 */

export type WebEnv = {
  ua: string;
  platform: string;
  maxTouchPoints: number;
  coarse: boolean;
  vibrate: ((p: number | number[]) => boolean) | null;
};

function readEnv(): WebEnv | null {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  if (!nav || typeof document === 'undefined') return null;
  const mq = globalThis.matchMedia?.('(pointer: coarse)');
  return {
    ua: nav.userAgent ?? '',
    platform: nav.platform ?? '',
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    coarse: !!mq?.matches,
    vibrate: typeof nav.vibrate === 'function' ? nav.vibrate.bind(nav) : null,
  };
}

/** iPhone / iPad（iPadOS 13 起 UA 冒充 Mac，靠触点数认出来） */
export function isIOS(env: Pick<WebEnv, 'ua' | 'platform' | 'maxTouchPoints'>): boolean {
  return /iPad|iPhone|iPod/.test(env.ua) || (env.platform === 'MacIntel' && env.maxTouchPoints > 1);
}

export type WebBackend = 'ios-switch' | 'vibrate' | 'none';

/** 选哪条路。iOS 优先认出来——iOS 上的 Chrome 也是 WebKit，同样没有 vibrate */
export function backendFor(env: WebEnv | null): WebBackend {
  if (!env) return 'none';
  if (isIOS(env)) return 'ios-switch';
  // 只在触屏上震：带触控板的笔记本 Chrome 也有 vibrate，但那儿不该震
  if (env.vibrate && env.coarse) return 'vibrate';
  return 'none';
}

/** 各语义在 Android 上震多久。差别不要编进几毫秒里——不少机器会把 10ms 以下的直接吞掉 */
export const VIBRATE: Record<'tap' | 'thud' | 'select' | 'success' | 'warn' | 'fail', number | number[]> = {
  select: 8,
  tap: 10,
  thud: 18,
  success: [10, 60, 10],
  warn: [14, 80, 14],
  fail: [18, 60, 18, 60, 18],
};

let env: WebEnv | null | undefined;
let backend: WebBackend | undefined;
function current(): WebBackend {
  if (backend === undefined) {
    env = readEnv();
    backend = backendFor(env);
  }
  return backend;
}

/** 覆盖层上一次收到真点击的时刻。`fire` 据此避免同一下点两次（覆盖层已经震过了） */
let overlayTapAt = 0;
export function markOverlayTap() { overlayTapAt = Date.now(); }

/** 程序化拨动用的那一对隐藏元素，第一次用时才建，整页共用一个 */
let fallbackLabel: HTMLLabelElement | null = null;
function fallbackSwitch(): HTMLLabelElement | null {
  if (fallbackLabel?.isConnected) return fallbackLabel;
  try {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.append(input);
    document.body.append(label);
    fallbackLabel = label;
    return label;
  } catch {
    return null;
  }
}

/** 网页端触发一次。所有失败都吞掉：触感是旁路 */
export function fireWeb(kind: keyof typeof VIBRATE): void {
  try {
    const b = current();
    if (b === 'vibrate') { env?.vibrate?.(VIBRATE[kind]); return; }
    if (b === 'ios-switch') {
      if (Date.now() - overlayTapAt < 400) return;
      fallbackSwitch()?.click();
    }
  } catch {
    // 什么都不做
  }
}

/** 这台设备上要不要铺覆盖层。只有 iOS 需要；别处铺了也无害，但没必要多一层 DOM */
export function wantsOverlay(): boolean {
  return current() === 'ios-switch';
}

/** 测试用：换一套环境 */
export function __setEnvForTest(e: WebEnv | null) {
  env = e;
  backend = backendFor(e);
  overlayTapAt = 0;
}
