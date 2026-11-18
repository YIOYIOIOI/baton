// 两个派生缓存，失效规则不同，不可共用一套 key。
//
// 这不是索引库：以文件事实为键，不匹配即丢弃重读，结构上不可能与文件不一致。
// 原则 #2 反对的是「自建第二个身份真源」，这里是备忘不是真源，不得以该原则为由删除。

// 头部缓存：transcript 是 append-only，文件头永不改变。
// 只有 size 变小（截断/替换）才说明这不再是同一个文件。
// 若改用 (size, mtime) 做 key，会在每次追加时无谓失效，
// 正好抵消「文件头不变」这个优化前提。
export function createHeadCache() {
  const m = new Map();
  return {
    get(file, size) {
      const hit = m.get(file);
      if (!hit) return undefined;
      if (size < hit.size) {
        m.delete(file);
        return undefined;
      }
      return hit.value;
    },
    set(file, size, value) {
      m.set(file, { size, value });
    },
    get size() {
      return m.size;
    },
  };
}

// 尾部缓存：尾部随每次追加改变，(size, mtime) 任一变化即失效。
export function createTailCache() {
  const m = new Map();
  return {
    get(file, size, mtimeMs) {
      const hit = m.get(file);
      if (!hit || hit.size !== size || hit.mtimeMs !== mtimeMs) return undefined;
      return hit.value;
    },
    set(file, size, mtimeMs, value) {
      m.set(file, { size, mtimeMs, value });
    },
    get size() {
      return m.size;
    },
  };
}
