import { create } from 'zustand';
import type { Client } from '@/api/client';
import type { FileEntry, FileListing } from '@/api/types';

/**
 * 会话文件浏览器的状态与纯函数。
 *
 * 浏览器本身是**每层一屏**的栈（app/files/[key].tsx，照 iOS「文件」App）：进目录 = 推一屏，
 * 返回 = 退一屏，原生上边缘右滑、网页上浏览器的后退都天然是「上一级」。于是有两样东西
 * 不能放在某一屏的 state 里，挪到这儿：
 *
 *   勾选     一边翻一边挑，跨层不能丢（owner：「勾选也可以勾选文件夹或者勾选文件都可以，
 *            然后点击确定才下载」）。按会话存，离开浏览器时清掉
 *   列表缓存 退回上一层时先把上次的列表摆出来，后台再问——否则每退一步都是一次白屏转圈
 */

// ── 分类与格式化 ──────────────────────────────────

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'ico', 'svg']);
const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php',
  'swift', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
  'lua', 'r', 'dart', 'm', 'mm', 'scala', 'pl', 'ex', 'exs', 'zig',
]);
const CONFIG_EXT = new Set(['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'xml', 'conf', 'cfg', 'properties', 'plist']);
const DOC_EXT = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'log', 'csv', 'tsv', 'diff', 'patch']);
const ARCHIVE_EXT = new Set(['zip', 'gz', 'tgz', 'rar', '7z', 'tar', 'bz2', 'xz']);
/** 没有扩展名但一看就是文本的那些（比小写） */
const TEXT_NAMES = new Set([
  'license', 'makefile', 'dockerfile', 'readme', 'procfile', 'gemfile', 'rakefile', 'vagrantfile',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.env', '.prettierrc', '.eslintrc',
]);

export type FileKind = 'dir' | 'image' | 'code' | 'config' | 'doc' | 'archive' | 'file';

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 和电脑网页端 web/src/FileBrowser.tsx 的 kindOf 同一套分法 */
export function kindOf(e: Pick<FileEntry, 'name' | 'dir'>): FileKind {
  if (e.dir) return 'dir';
  const x = extOf(e.name);
  if (IMAGE_EXT.has(x)) return 'image';
  if (CODE_EXT.has(x)) return 'code';
  if (CONFIG_EXT.has(x) || e.name.startsWith('.')) return 'config';
  if (DOC_EXT.has(x)) return 'doc';
  if (ARCHIVE_EXT.has(x)) return 'archive';
  return 'file';
}

/** 能当文本预览的：按扩展名和常见无扩展名文件判断。真正读到二进制时预览页还会再拦一道 */
export function isTextName(name: string): boolean {
  const x = extOf(name);
  return CODE_EXT.has(x) || CONFIG_EXT.has(x) || DOC_EXT.has(x)
    || TEXT_NAMES.has(name.toLowerCase()) || name.startsWith('.');
}

export function isMarkdown(name: string): boolean {
  return ['md', 'markdown', 'mdx'].includes(extOf(name));
}

/** 预览上限：文本 1 MB、图片 15 MB——和电脑端一致。再大的只给下载，读进来手机就卡死了 */
export const TEXT_MAX = 1024 * 1024;
export const IMAGE_MAX = 15 * 1024 * 1024;

export function fmtSize(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

/** 「刚刚」「3 分钟前」「今天 14:02」「昨天 14:02」「11/03 09:12」「2025/12/01」——和电脑端一致 */
export function fmtTime(ms: number | null, now: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const diff = now - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return `今天 ${hm}`;
  if (ms >= today.getTime() - 86_400_000) return `昨天 ${hm}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')} ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 绝对路径的最后一段。两种分隔符都认——服务端可能跑在任一平台上 */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export const joinRel = (at: string, name: string) => (at ? `${at}/${name}` : name);

/**
 * 面包屑：工作目录名打头，后面是相对路径的每一段。每一段带上「点它去哪」。
 * `''` 是工作目录本身。
 */
export function crumbsOf(rel: string, rootName: string): { name: string; path: string }[] {
  const out = [{ name: rootName, path: '' }];
  let acc = '';
  for (const seg of rel.split('/').filter(Boolean)) {
    acc = joinRel(acc, seg);
    out.push({ name: seg, path: acc });
  }
  return out;
}

export type SortKey = 'name' | 'mtime' | 'size';
export const SORT_LABEL: Record<SortKey, string> = { name: '名称', mtime: '修改时间', size: '大小' };

/**
 * 排序 + 筛选。**目录总在前面**（Finder、iOS 文件都这样），然后按选定的键：
 * 名称升序；时间、大小降序——看时间的人要的是「刚改过的」，看大小的人要的是「谁最占地方」。
 */
export function arrange(entries: FileEntry[], sort: SortKey, filter: string): FileEntry[] {
  const q = filter.trim().toLowerCase();
  const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice();
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  list.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (sort === 'mtime') return (b.mtime ?? 0) - (a.mtime ?? 0) || byName(a, b);
    if (sort === 'size') return (b.size ?? 0) - (a.size ?? 0) || byName(a, b);
    return byName(a, b);
  });
  return list;
}

// ── 列表缓存 ────────────────────────────────────

const listings = new Map<string, FileListing>();
const latestListing = new Map<string, symbol>();
export const useFileAccess = create(() => ({ identity: null as string | null, revision: 0 }));
export function setFileIdentity(identity: string | null) {
  if (useFileAccess.getState().identity === identity) return;
  listings.clear();
  latestListing.clear();
  clearPick();
  useFileAccess.setState((s) => ({ identity, revision: s.revision + 1 }));
}
export function invalidListing(error: unknown) {
  return [401, 403, 404].includes((error as { status?: number } | null)?.status ?? 0);
}
const cacheKey = (key: string, path: string) => `${key}\u0000${path}`;

export function cachedListing(key: string, path: string): FileListing | null {
  return listings.get(cacheKey(key, path)) ?? null;
}

export async function fetchListing(client: Client, key: string, path: string): Promise<FileListing> {
  const access = useFileAccess.getState();
  const id = cacheKey(key, path);
  const request = Symbol();
  latestListing.set(id, request);
  try {
    const data = await client.files(key, path);
    if (useFileAccess.getState() !== access || latestListing.get(id) !== request) throw new Error('stale_listing');
    if (access.identity) listings.set(id, data);
    if (listings.size > 200) listings.delete(listings.keys().next().value as string);
    return data;
  } catch (error) {
    if (useFileAccess.getState() === access && latestListing.get(id) === request && invalidListing(error)) {
      for (const entry of listings.keys()) if (entry.startsWith(key + '\u0000')) listings.delete(entry);
      for (const entry of latestListing.keys()) if (entry.startsWith(key + '\u0000')) latestListing.delete(entry);
      clearPick();
    }
    throw error;
  } finally {
    if (latestListing.get(id) === request) latestListing.delete(id);
  }
}

// ── 勾选 ────────────────────────────────────────

type PickState = {
  /** 当前在勾的是哪个会话的。换了会话就是另一批 */
  key: string | null;
  /** 相对工作目录的完整路径 → 是不是目录 */
  picked: Record<string, boolean>;
  /** 勾选模式开着吗。开着时点行是勾、不是打开 */
  selecting: boolean;
};

export const useFilePick = create<PickState>(() => ({ key: null, picked: {}, selecting: false }));

function forKey(key: string): PickState {
  const s = useFilePick.getState();
  return s.key === key ? s : { key, picked: {}, selecting: false };
}

export function togglePick(key: string, rel: string, dir: boolean) {
  const s = forKey(key);
  const picked = { ...s.picked };
  if (rel in picked) delete picked[rel]; else picked[rel] = dir;
  useFilePick.setState({ key, picked, selecting: true });
}

export function setSelecting(key: string, on: boolean) {
  const s = forKey(key);
  useFilePick.setState({ key, picked: on ? s.picked : {}, selecting: on });
}

export function clearPick() {
  useFilePick.setState({ key: null, picked: {}, selecting: false });
}

/**
 * 把勾上的东西摊平成一串文件路径，目录逐层展开。
 *
 * 逐层问服务端而不是要一棵树：服务端没有递归端点，加一个的话一个 node_modules 就能列出
 * 几万条。由界面按需展开，天然被「人勾了什么」限住。仍然给个上限，勾错了一个大目录时
 * 先停下来说清楚，而不是弹几千次分享面板。
 */
export const FLATTEN_CAP = 200;

export async function flattenPicked(
  list: (path: string) => Promise<FileListing>,
  picked: Record<string, boolean>,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue = Object.keys(picked).map((rel) => ({ rel, dir: picked[rel] }));
  const seen = new Set<string>();
  while (queue.length) {
    const { rel, dir } = queue.shift() as { rel: string; dir: boolean };
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!dir) {
      files.push(rel);
      if (files.length >= FLATTEN_CAP) return { files, truncated: true };
      continue;
    }
    const sub = await list(rel);
    for (const e of sub.entries) queue.push({ rel: joinRel(rel, e.name), dir: e.dir });
  }
  return { files, truncated: false };
}
