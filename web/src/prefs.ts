import { useSyncExternalStore } from 'react';
import type { Filter } from './sessions';

/**
 * 这台浏览器上的界面偏好。**只存本地**——它们是「我这块屏幕怎么看」，不是会话的属性：
 * 手机上选深色不该让电脑也变深色，这和模型、强度落在会话上正好相反。
 *
 * 一个模块级的小 store + useSyncExternalStore：侧栏、设置页、命令面板、快捷键都要读写
 * 同一份，挂 Context 的话外壳以外（命令面板挂在 body 上）还得再包一层。
 *
 * localStorage 随时可能抛（隐私模式、站点数据被禁），每一处读写都兜住；读不到就是默认值，
 * 界面照样能用，只是不记事。
 *
 * 主题、字号、对话宽度要在**首帧之前**落到 <html> 上，否则深色用户每次刷新先白闪一下。
 * index.html 里有一段同样逻辑的内联脚本，读的是同一个键——改这里的键名或取值要一起改。
 */

export type Theme = 'system' | 'light' | 'dark';
export type Size = 'sm' | 'md' | 'lg';
export type Width = 'normal' | 'wide';
/** 侧栏怎么排：按目录分组（原来的样子），或者跨目录按时间排（Claude 的「最近」） */
export type ListMode = 'folders' | 'recent';
export type LocalePref = 'auto' | 'en' | 'zh';

export type Prefs = {
  theme: Theme;
  size: Size;
  width: Width;
  listMode: ListMode;
  filter: Filter;
  showArchived: boolean;
  locale: LocalePref;
  /** 置顶的目录（分组键）。照 Claude Desktop 的「置顶文件夹」 */
  pinned: string[];
  /** 最近打开过的会话 key，新的在前。「回到上一个会话」用它 */
  visited: string[];
  /** 会话页右侧的「信息」窗格开着没有（宽屏）。窄屏上它是盖在对话上的抽屉，不记 */
  infoPanel: boolean;
};

const KEY = 'baton.prefs';
const DEFAULTS: Prefs = {
  theme: 'system',
  size: 'md',
  width: 'normal',
  listMode: 'folders',
  filter: 'all',
  showArchived: false,
  locale: 'auto',
  pinned: [],
  visited: [],
  infoPanel: true,
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const o = JSON.parse(raw) as Partial<Prefs>;
    // 逐项校验：手改过、或者老版本写进去的值不能把界面带歪
    const pick = <T,>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
    return {
      theme: pick(o.theme, ['system', 'light', 'dark'] as const, DEFAULTS.theme),
      size: pick(o.size, ['sm', 'md', 'lg'] as const, DEFAULTS.size),
      width: pick(o.width, ['normal', 'wide'] as const, DEFAULTS.width),
      listMode: pick(o.listMode, ['folders', 'recent'] as const, DEFAULTS.listMode),
      filter: pick(o.filter, ['all', 'claude', 'codex', 'antigravity'] as const, DEFAULTS.filter),
      showArchived: o.showArchived === true,
      locale: pick(o.locale, ['auto', 'en', 'zh'] as const, DEFAULTS.locale),
      pinned: Array.isArray(o.pinned) ? o.pinned.filter((x) => typeof x === 'string').slice(0, 50) : [],
      visited: Array.isArray(o.visited) ? o.visited.filter((x) => typeof x === 'string').slice(0, 20) : [],
      infoPanel: o.infoPanel !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

let state: Prefs = load();
const subs = new Set<() => void>();

function systemDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** 把会影响首帧的那几项写到 <html> 上。CSS 只认这几个属性，不认媒体查询 */
export function applyPrefs(p: Prefs = state) {
  const r = document.documentElement;
  r.dataset.theme = p.theme === 'system' ? (systemDark() ? 'dark' : 'light') : p.theme;
  r.dataset.size = p.size;
  r.dataset.width = p.width;
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  const active = p.locale === 'auto' ? (/^zh\b/i.test(nav) || !nav ? 'zh' : 'en') : p.locale;
  r.lang = active === 'zh' ? 'zh-CN' : 'en';
}

export function getPrefs(): Prefs {
  return state;
}

export function setPrefs(patch: Partial<Prefs>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 存不下就只在这次打开里生效
  }
  applyPrefs();
  subs.forEach((f) => f());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getPrefs,
  );
}

/** 记一次「打开了这个会话」。只留最近 20 个，重复的挪到最前 */
export function noteVisit(key: string) {
  if (state.visited[0] === key) return;
  setPrefs({ visited: [key, ...state.visited.filter((k) => k !== key)].slice(0, 20) });
}

export function togglePin(groupKey: string) {
  const has = state.pinned.includes(groupKey);
  setPrefs({ pinned: has ? state.pinned.filter((k) => k !== groupKey) : [...state.pinned, groupKey] });
}

// 跟随系统时，系统切了深浅色要跟着切，不用刷新
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyPrefs();
  });
} catch {
  // 老内核没有 addEventListener，那就刷新时再跟
}
