import { Platform } from 'react-native';
import { VIBRATE, fireWeb } from './webHaptics';

/**
 * 触感反馈。
 *
 * 改之前全 App **88 个可点元素，零触感**——在 iPhone 上这很不对劲：系统里
 * 每一次选择、每一次开关、每一次成功与失败都有对应的震动，一个完全不震的
 * App 会让人下意识觉得「没点到」。
 *
 * ## 为什么包一层而不是直接调 expo-haptics
 *
 * 1. **语义 > 强度**。调用点该说「这是一次选择」而不是「来个 Light 冲击」。
 *    强度是全局口径，要调就一处调完；散在几十个调用点里就永远不一致了。
 * 2. **网页不走 expo-haptics**。它在 web 上只会去调 Vibration API，而 iOS Safari
 *    根本不支持（Baton 的日常入口正是加到主屏的 PWA），桌面浏览器上让整台机器震
 *    一下更是错的。网页那条另有一套（2026-11-15 加）：Android 触屏用 vibrate，
 *    iOS 用 `<input switch>` 的系统轻震，桌面不震——取舍和代价见 webHaptics.ts。
 * 3. **失败必须吞掉**。触感是锦上添花，任何一次失败都不该让一次点击失败。
 *    expo-haptics 在模拟器、低电量模式、被系统限流时都可能抛。
 *
 * ## 用在哪、不用在哪
 *
 * 用：发送、停止、配对成功/失败、扫到码、选模型、切筛选、解除配对确认。
 * 不用：滚动、列表项进入、纯导航返回。**不是每次点击都震**——处处都震等于
 * 处处都不震，反而更吵。只在「这一下有后果」时给。
 */

type Haptics = {
  impactAsync: (style: unknown) => Promise<void>;
  notificationAsync: (type: unknown) => Promise<void>;
  selectionAsync: () => Promise<void>;
  ImpactFeedbackStyle: Record<string, unknown>;
  NotificationFeedbackType: Record<string, unknown>;
};

const WEB = Platform.OS === 'web';
let mod: Haptics | null = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 懒加载：原生模块可能不存在
    mod = require('expo-haptics') as Haptics;
  } catch {
    // 没装就安静地什么都不做
  }
}

/** 所有调用最终都经过这里：一处吞异常，一处判平台。 */
function fire(run: (h: Haptics) => Promise<void>, web: keyof typeof VIBRATE): void {
  if (WEB) { fireWeb(web); return; }
  if (!mod) return;
  // 不 await：触感是旁路，调用点不该为它多等一个微任务
  run(mod).catch(() => { /* 模拟器、低电量、被限流——都不该影响这次点击 */ });
}

/** 轻点。有后果的普通按钮：发送、确认、打开面板。 */
export const tap = () => fire((h) => h.impactAsync(h.ImpactFeedbackStyle.Light), 'tap');

/** 分量更重的一下。破坏性动作、停止正在跑的轮次。 */
export const thud = () => fire((h) => h.impactAsync(h.ImpactFeedbackStyle.Medium), 'thud');

/**
 * 选择变了。切 tab、选模型、开关筛选。
 *
 * 和 tap 是**两种不同的震动**，不是强弱之分：selection 是系统给「值变了」
 * 准备的那一下，iOS 上的选择器、分段控件都用它。混用会让选择感觉像按钮。
 */
export const select = () => fire((h) => h.selectionAsync(), 'select');

/** 成功。配对成功、一轮跑完。 */
export const success = () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Success), 'success');

/** 出了点问题但还能继续。排队而不是立即发出、附件过大。 */
export const warn = () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Warning), 'warn');

/** 失败。配对码无效、发送被拒、轮次异常结束。 */
export const fail = () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Error), 'fail');
