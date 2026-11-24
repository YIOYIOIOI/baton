import {
  CLAUDE_ROOT, CODEX_ROOT, GEMINI_ROOT,
  claudeSessionFiles, codexRolloutFiles, antigravitySessionFiles, decodeKey, sessionRef, parseAntigravityRel, isTransientFileError,
} from './providers.js';
import { readHead, readTail, parseLines } from './jsonl.js';
import { claudeHead, claudeTail, claudeFirstUserText } from './claude.js';
import { codexHead, codexFirstUserText } from './codex.js';
import {
  antigravityApp, antigravityHead, antigravityTail, antigravityFirstUserText,
} from './antigravity.js';
import { buildChains } from './chain.js';
import {
  CODEX_STATE_FILE, claudeApp, codexApp, codexIndexFileFor, codexThreadNames,
  resolveProject, resolveTitle,
} from './titles.js';
import { createHeadCache, createTailCache } from './cache.js';

/** 单个会话查找复用标题源的时长。见 createRepo 里 titleSources 那段。 */
const SOURCES_TTL_MS = 2000;
const CLAUDE_HEAD_LIMIT = 1024 * 1024;

/**
 * @param {{
 *   claudeRoot?: string, codexRoot?: string, registryRoot?: string,
 *   codexStateFile?: string, codexIndexFile?: string | null, geminiRoot?: string | null,
 * }} [opts]
 */
export function createRepo(opts = {}) {
  const {
    claudeRoot = CLAUDE_ROOT, codexRoot = CODEX_ROOT,
    registryRoot, codexStateFile = CODEX_STATE_FILE,
    codexIndexFile = codexStateFile ? codexIndexFileFor(codexStateFile) : null,
  } = opts;
  // 测试传自定义 claudeRoot/codexRoot 但没传 geminiRoot 时不扫本机 ~/.gemini，保证单测隔离
  const hasCustomOther = 'claudeRoot' in opts || 'codexRoot' in opts || 'registryRoot' in opts || 'codexStateFile' in opts;
  const geminiRoot = 'geminiRoot' in opts ? opts.geminiRoot : (hasCustomOther ? null : GEMINI_ROOT);
  const heads = createHeadCache();
  const tails = createTailCache();
  const counters = { headReads: 0, tailReads: 0, scanMs: 0, scans: 0, registryReads: 0 };
  const roots = { claude: claudeRoot, codex: codexRoot, antigravity: geminiRoot };

  function headFacts(ref) {
    const hit = heads.get(ref.file, ref.size);
    if (hit) return hit;
    counters.headReads += 1;
    const head = readHead(ref.file);
    let records = parseLines(head.lines);
    let value;
    if (ref.agent === 'claude') {
      if (head.truncated && !records.some(record => record?.cwd)) {
        records = parseLines(readHead(ref.file, CLAUDE_HEAD_LIMIT).lines);
      }
      value = { ...claudeHead(records, ref.providerId), threadSource: null, firstUserText: claudeFirstUserText(records) };
    } else if (ref.agent === 'antigravity') {
      value = { ...antigravityHead(records), threadSource: null, firstUserText: antigravityFirstUserText(records) };
    } else {
      value = { ...codexHead(records), parentId: null, firstUserText: codexFirstUserText(ref.file) };
    }
    const complete = ref.agent === 'antigravity' || Boolean(value.cwd)
      || (ref.agent === 'claude' ? ref.size >= CLAUDE_HEAD_LIMIT : head.truncated);
    heads.set(ref.file, ref.size, value, complete);
    return value;
  }

  function tailFacts(ref) {
    if (ref.agent === 'codex') return { customTitle: null, lastTs: null };
    const hit = tails.get(ref.file, ref.size, ref.mtimeMs);
    if (hit) return hit;
    counters.tailReads += 1;
    let value;
    if (ref.agent === 'antigravity') {
      value = { customTitle: null, ...antigravityTail(parseLines(readTail(ref.file).lines)) };
    } else {
      value = claudeTail(parseLines(readTail(ref.file).lines));
      if (!value.customTitle && !value.agentName && !value.aiTitle) {
        // 2026-10-01 全量 117 个：agent-name / ai-title 末条距文件尾最远 31 KB；
        // custom-title 有 1 个在 504 KB 处（另一个在 14 MB 处的是停写的重复副本，不列）。
        // 一个名字都没读到时放宽到 1 MB 再试一次
        value = claudeTail(parseLines(readTail(ref.file, 1024 * 1024).lines));
      }
    }
    tails.set(ref.file, ref.size, ref.mtimeMs, value);
    return value;
  }

  /*
    三个 App 的账本。桌面注册表要把 165 个 JSON 全读一遍（实测 14 ms），而按 key 取会话
    一屏缩略图就是十几次——所以单个查找复用 2 秒内读过的那份。列表每次都读新的：
    「App 里改了标题、手机上要跟着变」（v1 §6）靠的是它。
  */
  let sources = null;
  function titleSources({ fresh = false } = {}) {
    if (!fresh && sources && Date.now() - sources.at < SOURCES_TTL_MS) return sources;
    counters.registryReads += 1;
    const codex = codexStateFile ? codexApp({ file: codexStateFile }) : null;
    sources = {
      at: Date.now(),
      app: claudeApp({ root: registryRoot }),
      descriptions: codex?.descriptions ?? new Map(),
      chats: codex?.chats,
      names: codexIndexFile ? codexThreadNames({ file: codexIndexFile }) : new Map(),
      antigravityByDirectory: geminiRoot ? antigravityApp({ root: geminiRoot }).byDirectory : new Map(),
    };
    return sources;
  }

  // Codex 的子 agent 运行与真会话同目录同前缀，只能读头部区分（spec §2.2b）。
  // 读不到 thread_source 就放行——宁可多显示一条，不可丢真会话。
  function isSession(ref) {
    if (ref.agent !== 'codex') return true;
    const src = headFacts(ref).threadSource;
    return src === null || src === 'user';
  }

  function memberOf(ref, { app, descriptions, names, chats, antigravityByDirectory }) {
    const head = headFacts(ref);
    const tail = tailFacts(ref);
    const antigravity = ref.agent === 'antigravity' ? antigravityByDirectory.get(ref.project ?? '') : null;
    const ag = antigravity?.get(ref.providerId);
    // 授权和启动只认这份转录所在产品目录的宿主摘要；聊天正文和其他产品的同名记录不参与。
    const cwd = ref.agent === 'antigravity' ? ag?.cwd ?? null : head.cwd;
    const parentId = ag?.parentId ?? head.parentId ?? null;
    const { title, titleTier } = resolveTitle({
      agent: ref.agent, providerId: ref.providerId,
      registry: app.sessions, lineage: app.lineage, descriptions, names, antigravity,
      agentName: tail.agentName, customTitle: tail.customTitle, aiTitle: tail.aiTitle,
      firstUserText: head.firstUserText, cwd, firstTs: head.firstTs,
    });
    const own = ref.agent === 'claude'
      ? (app.sessions.get(ref.providerId) ?? app.lineage.get(ref.providerId))
      : null;
    return {
      key: ref.key, agent: ref.agent, providerId: ref.providerId, rolloutId: ref.rolloutId,
      file: ref.file, size: ref.size, mtimeMs: ref.mtimeMs,
      parentId, cwd, firstTs: head.firstTs,
      lastTs: tail.lastTs, title, titleTier,
      project: resolveProject({ agent: ref.agent, providerId: ref.providerId, cwd, app, chats, antigravity }),
      isArchived: own?.isArchived ?? false,
    };
  }

  /**
   * App 侧栏里没有这一行的，列表里也不出现：
   *   - Claude 被接替的旧段 / 删掉的墓碑
   *   - Antigravity nesting_depth > 0 的子代理或 killed = 1 的已删除会话
   */
  function inAppList(m, { app, antigravityByDirectory }) {
    if (m.agent === 'antigravity') {
      const s = antigravityByDirectory.get(m.project ?? '')?.get(m.providerId);
      if (s && (s.nestingDepth > 0 || s.killed)) return false;
      return true;
    }
    if (m.agent !== 'claude' || app.sessions.has(m.providerId)) return true;
    return !app.lineage.has(m.providerId) && !app.deleted.has(m.providerId);
  }

  /**
   * 同一个 id 两份 transcript（会话中途进了 worktree / 换了目录，CLI 在新目录下也写了
   * 一份）只留还在写的那份。2026-10-01 实测两例都是：首条记录相同，一份停写、
   * 一份一直写到现在。
   */
  function newestPerId(members) {
    const best = new Map();
    for (const m of members) {
      const k = `${m.agent}:${m.providerId}`;
      const had = best.get(k);
      if (!had || m.mtimeMs > had.mtimeMs) best.set(k, m);
    }
    return members.filter((m) => best.get(`${m.agent}:${m.providerId}`) === m);
  }

  function collect() {
    const t0 = Date.now();
    counters.scans += 1;
    const src = titleSources({ fresh: true });
    const refs = [
      ...claudeSessionFiles({ root: claudeRoot }),
      ...codexRolloutFiles({ root: codexRoot }),
      ...(geminiRoot ? antigravitySessionFiles({ root: geminiRoot }) : []),
    ];
    const members = [];
    for (const ref of refs) {
      try {
        if (isSession(ref) && inAppList(ref, src)) members.push(memberOf(ref, src));
      } catch (error) {
        if (!isTransientFileError(error)) throw error;
      }
    }
    counters.scanMs = Date.now() - t0;
    return newestPerId(members);
  }

  function lookup(target) {
    try {
      const ref = sessionRef(target.agent, roots[target.agent], target.relPath);
      return ref && isSession(ref) ? memberOf(ref, titleSources()) : null;
    } catch (error) {
      if (isTransientFileError(error)) return null;
      throw error;
    }
  }

  return {
    listChains() {
      return buildChains(collect());
    },
    // key 本来就指明了是哪个文件：只 stat 它一个，不再把两棵树整个列一遍
    getSession(key) {
      let target;
      try {
        target = decodeKey(key, roots);
      } catch {
        return null;
      }
      return lookup(target);
    },
    getSessionForRecovery(key) {
      let target;
      try { target = decodeKey(key, roots); } catch { return { status: 'unavailable' }; }
      const parts = target.relPath.split('/');
      // Only an explicit provider tombstone authorizes permanently discarding accepted work.
      if (target.agent === 'claude' && parts.length === 2 && parts[1].endsWith('.jsonl')) {
        const id = parts[1].slice(0, -6);
        if (titleSources().app.deleted.has(id) && titleSources({ fresh: true }).app.deleted.has(id)) return { status: 'missing' };
      }
      if (target.agent === 'antigravity') {
        const ref = parseAntigravityRel(parts);
        const killed = (sources) => ref && sources.antigravityByDirectory.get(ref.product ?? '')?.get(ref.providerId)?.killed;
        if (killed(titleSources()) && killed(titleSources({ fresh: true }))) return { status: 'missing' };
      }
      const member = lookup(target);
      return member ? { status: 'present', member } : { status: 'unavailable' };
    },
    stats() {
      return { ...counters };
    },
  };
}
