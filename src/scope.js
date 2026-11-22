import fs from 'node:fs';
import path from 'node:path';

// 上传落盘和静态服务共用的保留目录。
export const UPLOAD_DIR = '.baton-uploads';

/**
 * 路径归一化。
 *
 * **win32 折叠大小写是有实测依据的，不是保险起见**：真实 transcript 里
 * 同一目录常同时出现 `c:\workspace` 与 `C:\workspace` 两种大小写写法。
 * 不折叠的话 guest 的 root 写 `C:\...` 而会话记的是 `c:\...` 会直接漏判。
 *
 * POSIX 下**不能**折叠——那边路径本来就大小写敏感，折叠会把两个不同目录判成同一个。
 */
export function normPath(p) {
  if (!p) return '';
  const resolved = path.resolve(String(p));
  const root = path.parse(resolved).root;
  const r = resolved === root ? resolved : resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** child 是否就是 root 或落在 root 之下。 */
export function under(child, root) {
  return contained(normPath(child), normPath(root));
}

function contained(child, root) {
  if (!child || !root) return false;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return child === root || child.startsWith(prefix);
}

/** 已有路径取实际路径；待创建的后缀接在最近的真实上级目录上。悬空链接和解析错误均拒绝。 */
export function canonicalPath(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  let current = path.resolve(candidate);
  const missing = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(current);
      return path.join(real, ...missing.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
    }
    try {
      if (fs.lstatSync(current, { throwIfNoEntry: false })) return null;
    } catch {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    missing.push(path.basename(current));
    current = parent;
  }
}

/** 返回后续读写应使用的路径。先按授权的名字筛选，避免探测调用者指定的外部路径。 */
export function scopedPath(candidate, principal) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  const requested = path.resolve(candidate);
  const roots = principal?.roots ?? null;
  if (roots === null) return requested;
  let resolved;
  for (const [i, root] of roots.entries()) {
    const pinned = principal.realRoots?.[i];
    if (!under(requested, root) && !(pinned && under(requested, pinned))) continue;
    resolved ??= canonicalPath(requested);
    if (!resolved) return null;
    if (contained(resolved, pinned ?? canonicalPath(root))) return resolved;
  }
  return null;
}

/** roots 为 null = 不受限（owner）。cwd 缺失一律拒绝——读不到就无法判断归属。 */
export function inScope(cwd, roots) {
  if (roots === null || roots === undefined) return true;
  return scopedPath(cwd, { roots }) !== null;
}

/**
 * 按 principal 的 roots 过滤一个 repo。
 *
 * 这是整个工作区隔离的**唯一收口点**：handlers/ 下九个涉及会话的 handler 全部以
 * `repo.getSession(key)` 或 `repo.listChains()` 开头，所以包住这两个方法就等于
 * 包住全部端点，handler 一行不用改，也不存在「漏了一个端点」这种结构性风险。
 *
 * 各身份共享底层 repo 的 head / tail 缓存。使用会话时重新确认 cwd 的实际位置。
 */
export function scopeRepo(repo, principal) {
  const roots = principal?.roots ?? null;
  // owner 原样返回同一个对象：零开销，也保证这个改动对 owner 完全透明
  if (roots === null) return repo;

  function visibleMember(member) {
    const cwd = scopedPath(member?.cwd, principal);
    if (!cwd) return null;
    return cwd === member.cwd ? member : { ...member, cwd };
  }

  return {
    listChains() {
      const out = [];
      for (const c of repo.listChains()) {
        const members = c.members.map(visibleMember).filter(Boolean);
        if (members.length === 0) continue;
        // lastActivityMs 必须按剩下的成员重算：原值可能来自一个被滤掉的成员，
        // 留着等于泄露「这条链上还有你看不见的活动」
        out.push({
          ...c,
          members,
          lastActivityMs: members.reduce((mx, m) => (m.mtimeMs > mx ? m.mtimeMs : mx), 0),
        });
      }
      // buildChains 按 lastActivityMs 降序，重算之后要重排
      return out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    },

    getSession(key) {
      return visibleMember(repo.getSession(key));
    },

    stats() {
      return repo.stats();
    },
  };
}
