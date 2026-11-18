/**
 * 工作目录选择用到的路径小工具。纯字符串运算，不碰磁盘。
 *
 * 服务端给的都是**绝对路径**，而界面上一处绝对路径都不渲染（见 DirPicker.tsx
 * 抬头）。这里负责把它换成「从这个调用者看得见的顶开始的一串目录名」。
 */

import type { DirEntry } from './api';

/** 末段。药丸上放全路径会把它撑到半屏宽，而人认的是「哪个项目」。 */
export function dirName(cwd: string): string {
  const parts = segs(cwd);
  return parts[parts.length - 1] || cwd;
}

/** 从已有路径推分隔符，不写死 `\`：同一份代码也要能在 POSIX 机器上建目录。 */
function sep(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

export function join(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, '') + sep(dir) + name;
}

function segs(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/**
 * 同一个目录。折大小写：Windows 上 `C:\` 与 `c:\` 指同一个目录，实测两种写法在
 * 真实数据里并存（服务端 `scope.js` 的 normPath 因此也折）。
 */
export function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
}

/** `root` 的段是不是 `p` 的段的前缀（含相等）。按段比，不按字符串前缀——`C:\ab` 不在 `C:\a` 下。 */
function under(p: string[], root: string[]): boolean {
  return root.length <= p.length && root.every((s, i) => s.toLowerCase() === p[i].toLowerCase());
}

export type Crumb = { name: string; path: string };

/**
 * 「顶」：起点页那组入口里，不在别的入口下面的那些。
 *
 * owner 的起点页 = 盘符 + 用过的目录（服务端 `browseDirs` 两样都给），后者都在
 * 某个盘符下面，所以顶是盘符；访客的起点页 = 他的工作区根，顶就是它们自己。
 * 同一条规则，没有身份分支。
 */
export function topRoots(roots: DirEntry[]): DirEntry[] {
  return roots.filter((r) => {
    const rs = segs(r.path);
    return !roots.some((o) => o !== r && segs(o.path).length < rs.length && under(rs, segs(o.path)));
  });
}

/**
 * 一个绝对路径 → 从顶开始的一串目录名，每一段都带着它自己的路径（点了能跳过去）。
 *
 * 顶取**最短**的那个匹配：起点里可能既有 `C:` 也有 `C:\workspace\baton`
 * 本身，取最长的话 `baton` 会自己成了顶，看不出它在哪。
 *
 * 不在任何一个顶下面（起点还没读到、或者数据不一致）就只给末段——宁可少说，
 * 也不把绝对路径拿出来顶数。
 */
export function crumbsOf(path: string, roots: DirEntry[] | null): Crumb[] {
  const ps = segs(path);
  let best: DirEntry | null = null;
  for (const r of roots ?? []) {
    const rs = segs(r.path);
    if (under(ps, rs) && (!best || rs.length < segs(best.path).length)) best = r;
  }
  if (!best) return [{ name: dirName(path), path }];
  const out: Crumb[] = [{ name: best.name, path: best.path }];
  let cur = best.path;
  for (const s of ps.slice(segs(best.path).length)) {
    cur = join(cur, s);
    out.push({ name: s, path: cur });
  }
  return out;
}
