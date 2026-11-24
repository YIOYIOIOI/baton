import { useSyncExternalStore } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { useThemePref } from '../store/theme';
import {
  light, dark, fonts, size, weight, radius, space, layout, z, hairline, floatShadow,
  type Palette, type Shadow,
} from './tokens';

export type Theme = {
  c: Palette;
  isDark: boolean;
  fonts: typeof fonts;
  size: typeof size;
  weight: typeof weight;
  radius: typeof radius;
  space: typeof space;
  layout: typeof layout;
  z: typeof z;
  hairline: number;
  shadow: Shadow;
};

export function themeFor(isDark: boolean): Theme {
  return {
    c: isDark ? dark : light,
    isDark,
    fonts,
    size,
    weight,
    radius,
    space,
    layout,
    z,
    hairline,
    shadow: isDark ? floatShadow.dark : floatShadow.light,
  };
}

const DARK = '(prefers-color-scheme: dark)';

/**
 * 网页端自己订阅系统深浅色。
 *
 * **RN Web 的 `useColorScheme()` 读得到值，但不会因为值变了就通知组件重渲染。**
 * 后果不是「切换系统外观时不跟」这么简单——静态导出的首屏是在 Node 里预渲染的，
 * 那时没有 matchMedia，只能按浅色出；水合之后没人叫醒它们，于是**任何不因为别的
 * 原因重渲染的组件，就永远停在浅色上**。
 *
 * 浏览器里量到的（生产导出、深色系统、全新加载）：
 *
 *   页底            rgb(23,23,26)      深 ✓
 *   屏幕内的筛选栏   rgb(242,240,234)   深 ✓  ← 它因为会话列表加载而重渲染过
 *   底部 dock       rgb(34,33,31)      浅 ✗  ← 它没有任何状态，一次都没再渲染
 *
 * 两处是**同一个 Segmented 组件**，只是一个碰巧重渲染过、一个没有。单看哪个对
 * 都会看走眼，正是这一对照把病因钉死的。
 *
 * `useSyncExternalStore` 正是为这件事设计的：水合时用 getServerSnapshot，
 * 水合完成后 React 会再读一次 getSnapshot，不一致就重渲染。
 *
 * 这在别的 App 上也许无所谓，在 Baton 上不行：CLAUDE.md 写明日常入口是 PWA。
 */
function subscribeWeb(onChange: () => void): () => void {
  const mq = globalThis.matchMedia?.(DARK);
  if (!mq) return () => {};
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

const webDark = () => globalThis.matchMedia?.(DARK).matches ?? false;

/**
 * 预渲染跑在 Node 里，没有 matchMedia。按浅色出——这里返回 true 的话，
 * 浅色用户会先看到一帧深色再闪回来。
 */
const webDarkOnServer = () => false;

/**
 * 深浅色切换整个 token 对象，不做 CSS 媒体查询那套。
 *
 * 样式必须在渲染期内算出来，不能在模块顶层 `StyleSheet.create` 一次就完事——
 * 那样切到深色不会变。这是 RN 里最常见的一个主题 bug。
 *
 * 两个钩子都**无条件**调用（hooks 规则），只按平台取其中一个的结果：
 * 原生那条 `useColorScheme()` 是好用的，web 那条见上面 subscribeWeb。
 */
export function useTheme(): Theme {
  const nativeDark = useColorScheme() === 'dark';
  const web = useSyncExternalStore(subscribeWeb, webDark, webDarkOnServer);
  const pref = useThemePref((p) => p.pref);
  const system = Platform.OS === 'web' ? web : nativeDark;
  // 手动覆盖优先。'system' 是可以**选回去**的一档，不是「没选过」——
  // 只给明/暗两档的话，用户碰过一次就再也回不到跟随系统了。
  return themeFor(pref === 'system' ? system : pref === 'dark');
}

export { light, dark, type Palette };
