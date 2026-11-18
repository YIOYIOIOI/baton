function rootOf(session, byId) {
  if (session.agent === 'codex') return session.providerId;
  const seen = new Set([session.providerId]);
  let cur = session;
  while (cur.parentId) {
    // 成环：真实数据里不该出现（分叉的父指针总指向更早的会话），但不能死循环。
    // 取路径上字典序最小的 id 作链 key——与遍历起点无关，故环内成员归同一条链。
    if (seen.has(cur.parentId)) return [...seen].sort()[0];
    const next = byId.get(cur.parentId);
    // 悬挂父指针：父文件已被删除，仍以父 id 为链 key，
    // 否则同一祖先的多个子代会被拆成多条独立链。
    if (!next) return cur.parentId;
    seen.add(next.providerId);
    cur = next;
  }
  return cur.providerId;
}

export function buildChains(sessions) {
  const byId = new Map();
  for (const s of sessions) if (s.agent !== 'codex') byId.set(s.providerId, s);

  const groups = new Map();
  for (const s of sessions) {
    const chainKey = rootOf(s, byId);
    const gk = `${s.agent}:${chainKey}`;
    if (!groups.has(gk)) groups.set(gk, { chainKey, agent: s.agent, members: [], lastActivityMs: 0 });
    const g = groups.get(gk);
    g.members.push(s);
    if (s.mtimeMs > g.lastActivityMs) g.lastActivityMs = s.mtimeMs;
  }

  const order = (m) => (m.firstTs ? Date.parse(m.firstTs) : m.mtimeMs);
  for (const g of groups.values()) g.members.sort((a, b) => order(a) - order(b));
  return [...groups.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}
