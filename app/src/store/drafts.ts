import { useCallback } from 'react';
import { Platform } from 'react-native';
import { create } from 'zustand';
import type { Attachment } from '@/store/attach';

/**
 * 没发出去的草稿，按会话存。
 *
 * owner：「我打完字如果返回好像在回来的时候字会消失」。原来草稿是会话屏自己的
 * useState：一返回这一屏就卸载，字跟着没了。电脑网页端切会话是同一个毛病
 * （web/src/drafts.ts）。聊天软件的通行做法是按会话留草稿、回来还在——照做。
 *
 * 两层：
 *   内存   返回再进来、换个会话再回来。owner 撞上的就是这个
 *   落盘   App 被系统收掉、网页刷新之后也还在。**只存文字**：附件的预览地址是
 *          本机的 blob:/file:，换一次进程就失效了；附件本身已经在那台电脑上，
 *          丢的只是「随下一条带上」这个记号
 */

/** 新建会话那一屏的草稿。会话 key 形如 `claude:…`，撞不上它。 */
export const NEW_SESSION_DRAFT = 'new';

const WEB = Platform.OS === 'web';
/** 网页端和 web/src/drafts.ts 用同一个键、同一种格式：同一个浏览器里两套界面看到同一份草稿。 */
const STORE_KEY = 'baton.drafts';
const FILE_NAME = 'baton-drafts.json';
/** 选择器要返回稳定的引用，每次给一个新 [] 会让订阅它的组件无限重画。 */
const EMPTY: Attachment[] = [];

type Drafts = {
  text: Record<string, string>;
  attachments: Record<string, Attachment[]>;
};

const useDrafts = create<Drafts>(() => ({ text: {}, attachments: {} }));

export function setDraftText(key: string, value: string) {
  useDrafts.setState((s) => {
    const text = { ...s.text };
    // 清空就删掉这一项，别让盘上攒一堆空字符串
    if (value) text[key] = value;
    else delete text[key];
    return { text };
  });
  scheduleSave();
}

type Next = Attachment[] | ((prev: Attachment[]) => Attachment[]);

export function setDraftAttachments(key: string, next: Next) {
  useDrafts.setState((s) => {
    const value = typeof next === 'function' ? next(s.attachments[key] ?? EMPTY) : next;
    const attachments = { ...s.attachments };
    if (value.length) attachments[key] = value;
    else delete attachments[key];
    return { attachments };
  });
}

/** 不经 React 读当前值。测试和非组件代码用。 */
export function draftText(key: string): string {
  return useDrafts.getState().text[key] ?? '';
}

export function draftAttachments(key: string): Attachment[] {
  return useDrafts.getState().attachments[key] ?? EMPTY;
}

/** 这个会话的草稿文字。用法同 useState。 */
export function useDraft(key: string) {
  const value = useDrafts((s) => s.text[key] ?? '');
  const set = useCallback((v: string) => setDraftText(key, v), [key]);
  return [value, set] as const;
}

/** 这个会话挂着、等随下一条发出的附件。用法同 useState（也收函数）。 */
export function useDraftAttachments(key: string) {
  const value = useDrafts((s) => s.attachments[key] ?? EMPTY);
  const set = useCallback((next: Next) => setDraftAttachments(key, next), [key]);
  return [value, set] as const;
}

// ── 落盘 ──────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (timer) clearTimeout(timer);
  // 攒一下再写：每敲一个字写一次盘没有意义
  timer = setTimeout(() => {
    timer = null;
    void save(useDrafts.getState().text);
  }, 400);
}

async function save(text: Record<string, string>) {
  const json = JSON.stringify(text);
  try {
    if (WEB) {
      globalThis.localStorage?.setItem(STORE_KEY, json);
      return;
    }
    const { File, Paths } = await import('expo-file-system');
    const f = new File(Paths.document, FILE_NAME);
    if (!f.exists) f.create();
    f.write(json);
  } catch {
    // 存不上的代价只是「杀掉重开之后草稿没了」，不能因此打断打字
  }
}

async function load(): Promise<Record<string, unknown>> {
  try {
    if (WEB) return JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}');
    const { File, Paths } = await import('expo-file-system');
    const f = new File(Paths.document, FILE_NAME);
    return f.exists ? JSON.parse(await f.text()) : {};
  } catch {
    return {}; // 读不出来就当没有，多半是隐私模式或文件坏了
  }
}

// 启动时读回来。**只补内存里还空着的**：读盘是异步的，这期间已经打了字的
// 那一份更新，不能被盘上旧的盖掉。
void load().then((saved) => {
  const add: Record<string, string> = {};
  for (const [k, v] of Object.entries(saved ?? {})) if (typeof v === 'string' && v) add[k] = v;
  if (Object.keys(add).length) useDrafts.setState((s) => ({ text: { ...add, ...s.text } }));
});
