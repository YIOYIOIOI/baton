import { useCallback } from 'react';
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import type { Attachment } from '@/store/attach';
import { draftScope, getBrowserLock, rememberBrowserScope } from './browserSession';
import { deleteSecret, getSecret, setSecret } from './secure';
import { clearMobileSends, markMobileDraftConsumed, type MobileSend } from './mobilePending';

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

const web = () => Platform.OS === 'web';
let scope: string | null = null;
let generation = 0;
let storageQueue: Promise<void> = Promise.resolve();
const dirty = new Set<string>();
let persistedText: Record<string, string> = {};
/** 选择器要返回稳定的引用，每次给一个新 [] 会让订阅它的组件无限重画。 */
const EMPTY: Attachment[] = [];

type Drafts = {
  scope: string | null;
  text: Record<string, string>;
  attachments: Record<string, Attachment[]>;
};

const useDrafts = create<Drafts>(() => ({ scope: null, text: {}, attachments: {} }));

export const useDraftScope = () => useDrafts((state) => state.scope);

export function setDraftText(key: string, value: string) {
  if (!scope || (web() && getBrowserLock())) return;
  dirty.add(key);
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
  if (!scope) return;
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
  const owner = useDrafts((s) => s.scope);
  const value = useDrafts((s) => s.text[key] ?? '');
  const set = useCallback((v: string) => { if (scope === owner) setDraftText(key, v); }, [key, owner]);
  return [value, set] as const;
}

/** 这个会话挂着、等随下一条发出的附件。用法同 useState（也收函数）。 */
export function useDraftAttachments(key: string) {
  const owner = useDrafts((s) => s.scope);
  const value = useDrafts((s) => s.attachments[key] ?? EMPTY);
  const set = useCallback((next: Next) => { if (scope === owner) setDraftAttachments(key, next); }, [key, owner]);
  return [value, set] as const;
}

// ── 落盘 ──────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 400);
}

function readText(target: string): Record<string, string> {
  let data: string | null = null;
  if (web()) data = localStorage.getItem(target);
  else {
    const file = new File(Paths.document, target + '.json');
    if (file.exists) data = file.textSync();
  }
  return JSON.parse(data ?? '{}');
}

function writeText(target: string, value: Record<string, string>) {
  const json = JSON.stringify(value);
  if (web()) localStorage.setItem(target, json);
  else {
    const file = new File(Paths.document, target + '.json');
    if (!file.exists) file.create();
    file.write(json);
  }
  if (target === scope) persistedText = value;
}

/** Clear only this operation's source text. The POST must wait for both durable writes. */
export function commitSubmittedDraft(entry: MobileSend, original: string, fromComposer = false) {
  if (scope !== entry.scope || (web() && getBrowserLock())) throw new Error('send_storage');
  if (entry.draftConsumed && !fromComposer) return;
  const key = entry.session;
  const current = draftText(key);
  const matches = (value: string | undefined) => entry.sourceDraft !== undefined ? value === original : value?.trim() === original.trim();
  const stored = readText(entry.scope);
  if (current && !matches(current)) stored[key] = current;
  else if (matches(stored[key]) || (matches(current) && stored[key] === persistedText[key])) delete stored[key];
  writeText(entry.scope, stored);
  markMobileDraftConsumed(entry);
  if (matches(current)) useDrafts.setState((s) => {
    const text = { ...s.text }; delete text[key]; return { text };
  });
  dirty.delete(key);
}

/** Preserve newer input before retiring a confirmed operation, even inside its debounce interval. */
export function persistNextDraft(owner: string, key: string) {
  if (scope !== owner || (web() && getBrowserLock())) throw new Error('send_storage');
  if (!dirty.has(key)) return;
  const stored = readText(owner);
  const next = draftText(key);
  if (next) stored[key] = next; else delete stored[key];
  writeText(owner, stored);
  dirty.delete(key);
}

function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!scope) return;
  if (web() && getBrowserLock()) return;
  if (!dirty.size) return;
  try {
    const stored = readText(scope);
    for (const key of dirty) { const text = draftText(key); if (text) stored[key] = text; else delete stored[key]; }
    writeText(scope, stored);
    dirty.clear();
  } catch { /* Keep dirty input in memory; a send requires its own successful write. */ }
}

export async function selectDraftIdentity(origin: string, principal: string, assigned?: string) {
  const next = draftScope(origin, principal, assigned);
  if (scope === next) return;
  if (timer) flush();
  dirty.clear();
  persistedText = {};
  const revision = ++generation;
  scope = next;
  useDrafts.setState({ scope, text: {}, attachments: {} });
  try {
    if (web()) {
      rememberBrowserScope(next);
    } else {
      storageQueue = storageQueue.then(() => setSecret('baton.drafts.active', next)).catch(() => {});
      const legacy = new File(Paths.document, 'baton-drafts.json');
      if (legacy.exists) legacy.delete();
    }
    if (revision !== generation) return;
    const parsed = readText(next);
    persistedText = parsed;
    const saved = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
    useDrafts.setState((s) => ({ text: { ...saved, ...s.text } }));
  } catch { /* Keep the in-memory draft if storage is unavailable. */ }
}

export function resetDraftIdentity(remove = false) {
  const previous = scope;
  if (timer && !remove) flush();
  if (timer) clearTimeout(timer);
  timer = null;
  dirty.clear();
  persistedText = {};
  ++generation;
  scope = null;
  useDrafts.setState({ scope: null, text: {}, attachments: {} });
  if (!remove) return storageQueue;
  if (web()) {
    try { if (previous) { localStorage.removeItem(previous); clearMobileSends(previous); } } catch { /* The in-memory copy has been cleared. */ }
  } else {
    storageQueue = storageQueue.then(async () => {
      const target = previous ?? await getSecret('baton.drafts.active');
      if (!target?.startsWith('baton.drafts.v2.')) return;
      clearMobileSends(target);
      const file = new File(Paths.document, target + '.json');
      if (file.exists) file.delete();
      await deleteSecret('baton.drafts.active');
    }).catch(() => {});
  }
  return storageQueue;
}
