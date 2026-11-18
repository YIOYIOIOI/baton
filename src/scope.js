import path from 'node:path';

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
  const c = normPath(child);
  const r = normPath(root);
  if (!c || !r) return false;
  // `+ path.sep` 不能省：没有它，root `ws\friend` 会匹配到 `ws\friend-other`；
  // 根目录自身末尾已有分隔符，不再重复拼接。
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c === r || c.startsWith(prefix);
}

/** roots 为 null = 不受限（owner）。cwd 缺失一律拒绝——读不到就无法判断归属。 */
export function inScope(cwd, roots) {
  if (roots === null || roots === undefined) return true;
  if (!cwd) return false;
  return roots.some((r) => under(cwd, r));
}

/**
 * 按 principal 的 roots 过滤一个 repo。
 *
 * 这是整个工作区隔离的**唯一收口点**：handlers/ 下九个涉及会话的 handler 全部以
 * `repo.getSession(key)` 或 `repo.listChains()` 开头，所以包住这两个方法就等于
 * 包住全部端点，handler 一行不用改，也不存在「漏了一个端点」这种结构性风险。
 *
 * **无状态包装**，底层 repo 的 head / tail 缓存照旧共享——不会因为分身份多读一次盘。
 */
export function scopeRepo(repo, principal) {
  const roots = principal?.roots ?? null;
  // owner 原样返回同一个对象：零开销，也保证这个改动对 owner 完全透明
  if (roots === null) return repo;

  return {
    listChains() {
      const out = [];
      for (const c of repo.listChains()) {
        const members = c.members.filter((m) => inScope(m.cwd, roots));
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
      const m = repo.getSession(key);
      return m && inScope(m.cwd, roots) ? m : null;
    },

    stats() {
      return repo.stats();
    },
  };
}
