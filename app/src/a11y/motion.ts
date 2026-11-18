import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * 「减弱动效」开着吗。
 *
 * ## 为什么必须有这一条
 *
 * 系统里这是两个**互相独立**的开关，我们一度只接了后者：
 *
 *   减弱动效（Reduce Motion）        位移、缩放、视差、回弹 → 前庭不适、晕动
 *   降低透明度（Reduce Transparency） 毛玻璃、半透明       → 看不清
 *
 * `Glass.tsx` 里的 `useReduceTransparency` 管的是第二个。第一个在这次审查
 * 之前**全仓库一处都没有**——所有动画照跑。
 *
 * ## 减弱不等于取消
 *
 * 苹果的原则是「更少、更温和」，不是「一动不动」：
 *
 *   砍掉  位移、缩放、视差、回弹过冲、循环摆动
 *   留下  透明度与颜色变化——它们解释「状态变了」，去掉之后界面会开始跳变，
 *         那对任何人都更糟
 *
 * 所以调用方拿到 true 之后该做的是**换一种表达**（淡入淡出、瞬切），
 * 不是把 duration 设成 0 了事。
 *
 * ## 为什么不用 Reanimated 的 useReducedMotion
 *
 * 它有，而且我们装了 Reanimated 4.5.1。但这个 App 的动画绝大多数跑在核心
 * `Animated` 上（见 Segmented / Sheet / keyboard），而 Reanimated 那个钩子
 * 在 web 上的行为和我们已有的 `useReduceTransparency` 不是一套。照抄自己
 * 已有的那套模式，两个无障碍开关的读法就完全一致，不会出现「一个跟得上系统
 * 变更、另一个要重启 App」这种只在真机上才发现的差异。
 */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
      if (!mq) return undefined;
      setOn(mq.matches);
      const onChange = (e: MediaQueryListEvent) => setOn(e.matches);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    // 必须是订阅而不是一次性读取：用户可以在 App 跑着的时候去系统设置里拨这个
    // 开关，回来时界面要立刻跟上。
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setOn(v); })
      .catch(() => { /* 读不到就按没开处理——有动画总比界面乱跳强 */ });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => { alive = false; sub.remove(); };
  }, []);

  return on;
}
