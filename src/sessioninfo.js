import fs from 'node:fs';
import path from 'node:path';
import { commandOf } from './claude.js';
import {
  extractGoalCommand, extractSettingsModel, normalizeToolArgs,
} from './antigravity.js';
import { displayName } from './agent/catalog.js';

/**
 * 会话页右侧「信息」窗格要的东西，从会话文件里读（2026-11-10）。
 *
 * owner：「右侧的信息窗口也没有复刻 claude desktop」。Claude Desktop 那个窗格画的是它自己注入给
 * agent 的几个工具留下的数据——本机最近 40 个 Claude 会话里数过：
 *
 *   mcp__ccd_turn__update_plan   136 次  计划：{ items: [{content, status}] }，之后 { advance: true } 推进
 *   mcp__ccd_turn__wrap_up        40 次  一段收尾总结：{ recap }
 *   TodoWrite                      0 次  （老的任务清单工具，这台机器上已经没人用了，仍兼容）
 *
 * 再加上 Baton 自己能读到的：用的模型、上下文用了多少、/goal 的目标、改过哪些文件、git 分支。
 *
 * 会话文件能到几十 MB，所以**按偏移增量读**：第一次整份读，之后只解析新追加的那段。
 * 解析出来的状态挂在内存里——这是个缓存，丢了从头读一遍就回来了，不是运行态。
 */

/** @typedef {{ content: string, status: 'pending'|'in_progress'|'completed' }} PlanItem */
/** @typedef {{ path: string, edits: number, added: number, removed: number, lastTs: string|null, created: boolean }} FileStat */

export function emptyState() {
  return {
    cwd: /** @type {string|null} */ (null),
    model: /** @type {string|null} */ (null),
    context: /** @type {{ used: number, window: number|null, ts: string|null }|null} */ (null),
    goal: /** @type {{ condition: string, met: boolean, reason: string|null, setAt: string|null }|null} */ (null),
    plan: /** @type {PlanItem[]|null} */ (null),
    recap: /** @type {{ text: string, ts: string|null }|null} */ (null),
    /** @type {Map<string, FileStat>} */
    files: new Map(),
  };
}

const lines = (s) => (typeof s === 'string' && s ? s.split('\n').length : 0);

/** `items` 换整张表；`advance` 把进行中的那条打勾、下一条待办变成进行中（照字面意思推的） */
export function applyPlan(plan, input) {
  if (Array.isArray(input?.items)) {
    return input.items
      .filter((x) => typeof x?.content === 'string')
      .map((x) => ({ content: x.content, status: ['pending', 'in_progress', 'completed'].includes(x.status) ? x.status : 'pending' }));
  }
  if (input?.advance === true && Array.isArray(plan)) {
    const next = plan.map((x) => ({ ...x }));
    const cur = next.findIndex((x) => x.status === 'in_progress');
    if (cur >= 0) next[cur].status = 'completed';
    const after = next.findIndex((x, i) => i > cur && x.status === 'pending');
    if (after >= 0) next[after].status = 'in_progress';
    return next;
  }
  return plan;
}

function touch(state, file, { added = 0, removed = 0, created = false, ts = null }) {
  if (typeof file !== 'string' || !file) return;
  let rel = file;
  if (state.cwd) {
    const r = path.relative(state.cwd, file);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r;
  }
  rel = rel.replace(/\\/g, '/');
  const f = state.files.get(rel) ?? { path: rel, edits: 0, added: 0, removed: 0, lastTs: null, created: false };
  f.edits += 1;
  f.added += added;
  f.removed += removed;
  f.created ||= created;
  f.lastTs = ts ?? f.lastTs;
  state.files.set(rel, f);
}

/** 一条 Claude 记录推进状态 */
export function applyClaude(state, r) {
  if (!r || typeof r !== 'object' || r.isSidechain === true) return;
  const ts = r.timestamp ?? null;
  if (!state.cwd && typeof r.cwd === 'string') state.cwd = r.cwd;

  if (r.type === 'attachment' && r.attachment?.type === 'goal_status' && typeof r.attachment.condition === 'string') {
    const g = r.attachment;
    state.goal = {
      condition: g.condition,
      met: g.met === true,
      reason: typeof g.reason === 'string' ? g.reason : null,
      setAt: g.sentinel === true ? ts : (state.goal?.condition === g.condition ? state.goal.setAt : ts),
    };
    return;
  }

  if (r.type === 'user' && !r.isMeta) {
    const c = r.message?.content;
    const texts = typeof c === 'string' ? [c] : (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text) : []);
    for (const t of texts) {
      const cmd = commandOf(t);
      if (cmd?.name === 'goal' && /^(clear|stop|off|cancel)$/i.test(cmd.args)) state.goal = null;
    }
    return;
  }

  if (r.type !== 'assistant') return;
  const m = r.message;
  if (typeof m?.model === 'string' && m.model !== '<synthetic>') state.model = m.model;
  const u = m?.usage;
  if (u && typeof u.input_tokens === 'number') {
    state.context = {
      used: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      window: null,
      ts,
    };
  }
  for (const b of Array.isArray(m?.content) ? m.content : []) {
    if (b?.type !== 'tool_use') continue;
    const inp = b.input ?? {};
    switch (b.name) {
      case 'Edit':
        touch(state, inp.file_path, { added: lines(inp.new_string), removed: lines(inp.old_string), ts });
        break;
      case 'MultiEdit':
        touch(state, inp.file_path, {
          added: (inp.edits ?? []).reduce((n, e) => n + lines(e?.new_string), 0),
          removed: (inp.edits ?? []).reduce((n, e) => n + lines(e?.old_string), 0),
          ts,
        });
        break;
      case 'Write':
        touch(state, inp.file_path, { added: lines(inp.content), created: true, ts });
        break;
      case 'NotebookEdit':
        touch(state, inp.notebook_path, { added: lines(inp.new_source), ts });
        break;
      case 'mcp__ccd_turn__update_plan':
        state.plan = applyPlan(state.plan, inp);
        break;
      case 'TodoWrite':
        if (Array.isArray(inp.todos)) state.plan = applyPlan(null, { items: inp.todos });
        break;
      case 'mcp__ccd_turn__wrap_up':
        if (typeof inp.recap === 'string' && inp.recap.trim()) state.recap = { text: inp.recap.trim(), ts };
        break;
      default:
    }
  }
}

/** 一条 Codex 记录推进状态 */
export function applyCodex(state, r) {
  if (!r || typeof r !== 'object') return;
  const p = r.payload;
  if (r.type === 'turn_context') {
    if (typeof p?.model === 'string') state.model = p.model;
    if (!state.cwd && typeof p?.cwd === 'string') state.cwd = p.cwd;
    return;
  }
  if (r.type === 'session_meta' && !state.cwd && typeof p?.cwd === 'string') state.cwd = p.cwd;
  if (r.type === 'event_msg' && p?.type === 'token_count' && p.info?.last_token_usage) {
    state.context = {
      used: p.info.last_token_usage.input_tokens ?? 0,
      window: typeof p.info.model_context_window === 'number' ? p.info.model_context_window : null,
      ts: r.timestamp ?? null,
    };
  }
  if (r.type === 'response_item' && p?.type === 'function_call' && p.name === 'update_plan') {
    try {
      const a = JSON.parse(p.arguments ?? '{}');
      if (Array.isArray(a.plan)) state.plan = applyPlan(null, { items: a.plan.map((x) => ({ content: x.step, status: x.status })) });
    } catch {
      // 参数不是 JSON，跳过
    }
  }
}

/** 一条 Antigravity 记录推进状态 */
export function applyAntigravity(state, r) {
  if (!r || typeof r !== 'object') return;
  const ts = r.created_at ?? null;
  if (r.type === 'USER_INPUT') {
    const m = extractSettingsModel(r.content);
    if (m) state.model = m;
    const goal = extractGoalCommand(r.content);
    if (goal) {
      if (goal.clear) state.goal = null;
      else if (goal.condition) {
        state.goal = {
          condition: goal.condition,
          met: false,
          reason: null,
          setAt: state.goal?.condition === goal.condition ? state.goal.setAt : ts,
        };
      }
    }
    return;
  }

  if (r.type !== 'PLANNER_RESPONSE' && r.type !== 'CHECKPOINT') return;
  if (typeof r.input_tokens === 'number') {
    state.context = {
      used: (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0),
      window: null,
      ts,
    };
  }
  if (typeof r.content === 'string' && r.content.includes('<!-- GOAL_COMPLETE -->') && state.goal) {
    state.goal = { ...state.goal, met: true, reason: '模型输出 GOAL_COMPLETE 标记' };
  }
  for (const tc of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
    const inp = normalizeToolArgs(tc?.args ?? {});
    switch (tc?.name) {
      case 'edit_file':
        touch(state, inp.Path, { added: lines(inp.Replacement), removed: lines(inp.Target), ts });
        break;
      case 'write_file':
        touch(state, inp.Path, {
          added: lines(inp.Content), created: inp.Overwrite !== true && inp.Append !== true, ts,
        });
        break;
      case 'replace_file_content':
        touch(state, inp.TargetFile, { added: lines(inp.ReplacementContent), removed: lines(inp.TargetContent), ts });
        break;
      case 'multi_replace_file_content':
        touch(state, inp.TargetFile, {
          added: (inp.ReplacementChunks ?? []).reduce((n, c) => n + lines(c?.ReplacementContent), 0),
          removed: (inp.ReplacementChunks ?? []).reduce((n, c) => n + lines(c?.TargetContent), 0),
          ts,
        });
        break;
      default:
    }
  }
}

const INFO_CHUNK_BYTES = 4 * 1024 * 1024;
const INFO_MAX_LINE_BYTES = 16 * 1024 * 1024;
const EDITS_TAIL_BYTES = 32 * 1024 * 1024;

/** Stream lines incrementally from offset in bounded chunks so cold huge transcripts never OOM. */
export function scanFrom(file, offset, size, onLine, {
  chunkBytes = INFO_CHUNK_BYTES,
  maxLineBytes = INFO_MAX_LINE_BYTES,
} = {}) {
  if (size <= offset) return offset;
  const fd = fs.openSync(file, 'r');
  let readPos = offset;
  let committed = offset;
  let carry = Buffer.alloc(0);
  let skipping = false;
  try {
    const chunk = Buffer.alloc(Math.min(chunkBytes, Math.max(1, size - offset)));
    while (readPos < size) {
      const toRead = Math.min(chunk.length, size - readPos);
      const n = fs.readSync(fd, chunk, 0, toRead, readPos);
      if (n <= 0) break;
      const sliceStart = readPos;
      readPos += n;
      let slice = chunk.subarray(0, n);

      if (skipping) {
        const nl = slice.indexOf(0x0a);
        if (nl < 0) {
          committed = readPos;
          continue;
        }
        committed = sliceStart + nl + 1;
        skipping = false;
        slice = slice.subarray(nl + 1);
        if (!slice.length) continue;
      }

      const combined = carry.length ? Buffer.concat([carry, slice]) : slice;
      let pos = 0;
      let nl;
      while ((nl = combined.indexOf(0x0a, pos)) >= 0) {
        const lineBuf = combined.subarray(pos, nl);
        committed += lineBuf.length + 1;
        pos = nl + 1;
        if (lineBuf.length) onLine(lineBuf.toString('utf8'));
      }

      const rem = combined.subarray(pos);
      if (rem.length > maxLineBytes) {
        carry = Buffer.alloc(0);
        skipping = true;
        committed = readPos;
      } else {
        carry = Buffer.from(rem);
      }
    }
    return committed;
  } finally {
    fs.closeSync(fd);
  }
}

/** @type {Map<string, { offset: number, state: ReturnType<typeof emptyState>, mtimeMs: number }>} */
const cache = new Map();

/**
 * 读出一个会话的信息。
 *
 * @param {{ agent: string, file: string, cwd?: string|null }} member
 * @param {{ windowOf?: (model: string) => number|null }} [opts]
 */
export function readSessionInfo(member, { windowOf = () => null } = {}) {
  let st;
  try {
    st = fs.statSync(member.file);
  } catch {
    return null;
  }
  let hit = cache.get(member.file);
  // 文件变小了（被重写过）：从头来
  if (!hit || st.size < hit.offset || (member.agent === 'antigravity' && hit.state.cwd !== (member.cwd ?? null))) {
    hit = { offset: 0, state: emptyState(), mtimeMs: 0 };
    if (member.cwd) hit.state.cwd = member.cwd;
  }
  const apply = member.agent === 'codex'
    ? applyCodex
    : member.agent === 'antigravity'
      ? applyAntigravity
      : applyClaude;
  const end = scanFrom(member.file, hit.offset, st.size, (line) => {
    try {
      apply(hit.state, JSON.parse(line));
    } catch {
      // 坏行跳过
    }
  });
  hit.offset = end;
  hit.mtimeMs = st.mtimeMs;
  cache.set(member.file, hit);

  const s = hit.state;
  const context = s.context
    ? { ...s.context, window: s.context.window ?? (s.model ? windowOf(s.model) : null) }
    : null;
  return {
    agent: member.agent,
    cwd: s.cwd ?? member.cwd ?? null,
    branch: gitBranch(s.cwd ?? member.cwd ?? null),
    model: s.model ? { id: s.model, name: displayName(s.model) } : null,
    context,
    goal: s.goal,
    plan: s.plan,
    recap: s.recap,
    files: [...s.files.values()].sort((a, b) => String(b.lastTs ?? '').localeCompare(String(a.lastTs ?? ''))).slice(0, 80),
    fileCount: s.files.size,
    // Codex 0.164 改文件走 exec（本机 2968 次，没有单独的改文件记录），统计不出来——如实说；Antigravity 走结构化工具，可跟踪
    filesTracked: member.agent === 'claude' || member.agent === 'antigravity',
  };
}

/**
 * 某个文件在这个会话里的每一次改动（点开文件时看）。要从头扫一遍会话文件，只在点开时调。
 * 每次改动给出改前改后两段原文，各截到 4000 字。
 */
export function fileEdits(member, rel, { max = 40 } = {}) {
  let text;
  try {
    const st = fs.statSync(member.file);
    if (st.size <= EDITS_TAIL_BYTES) {
      text = fs.readFileSync(member.file, 'utf8');
    } else {
      const fd = fs.openSync(member.file, 'r');
      try {
        const buf = Buffer.alloc(EDITS_TAIL_BYTES);
        const n = fs.readSync(fd, buf, 0, EDITS_TAIL_BYTES, st.size - EDITS_TAIL_BYTES);
        const slice = buf.subarray(0, n);
        const firstNl = slice.indexOf(0x0a);
        text = (firstNl >= 0 ? slice.subarray(firstNl + 1) : slice).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return [];
  }
  const want = String(rel).replace(/\\/g, '/');
  const cwd = member.cwd ?? null;
  const same = (p) => {
    if (typeof p !== 'string') return false;
    const r = cwd ? path.relative(cwd, p) : p;
    const normR = r.replace(/\\/g, '/');
    const normP = p.replace(/\\/g, '/');
    return process.platform === 'win32'
      ? (normR.toLowerCase() === want.toLowerCase() || normP.toLowerCase() === want.toLowerCase())
      : (normR === want || normP === want);
  };
  const cut = (s) => (typeof s === 'string' ? (s.length > 4000 ? `${s.slice(0, 4000)}\n…（后面还有 ${s.length - 4000} 字）` : s) : '');
  const out = [];
  if (member.agent === 'antigravity') {
    for (const line of text.split('\n')) {
      if (!line.includes('"tool_calls"')) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.type !== 'PLANNER_RESPONSE') continue;
      const ts = r.created_at ?? null;
      for (const tc of r.tool_calls ?? []) {
        const i = normalizeToolArgs(tc?.args ?? {});
        if (tc?.name === 'edit_file' && same(i.Path)) {
          out.push({ ts, kind: 'edit', before: cut(i.Target), after: cut(i.Replacement) });
        } else if (tc?.name === 'write_file' && same(i.Path)) {
          out.push({ ts, kind: 'write', before: '', after: cut(i.Content) });
        } else if (tc?.name === 'replace_file_content' && same(i.TargetFile)) {
          out.push({ ts, kind: 'edit', before: cut(i.TargetContent), after: cut(i.ReplacementContent) });
        } else if (tc?.name === 'multi_replace_file_content' && same(i.TargetFile)) {
          for (const c of i.ReplacementChunks ?? []) {
            out.push({ ts, kind: 'edit', before: cut(c?.TargetContent), after: cut(c?.ReplacementContent) });
          }
        }
      }
    }
    return out.slice(-max);
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type !== 'assistant' || r.isSidechain === true) continue;
    for (const b of r.message?.content ?? []) {
      if (b?.type !== 'tool_use') continue;
      const i = b.input ?? {};
      if (b.name === 'Edit' && same(i.file_path)) out.push({ ts: r.timestamp ?? null, kind: 'edit', before: cut(i.old_string), after: cut(i.new_string) });
      else if (b.name === 'MultiEdit' && same(i.file_path)) {
        for (const e of i.edits ?? []) out.push({ ts: r.timestamp ?? null, kind: 'edit', before: cut(e?.old_string), after: cut(e?.new_string) });
      } else if (b.name === 'Write' && same(i.file_path)) out.push({ ts: r.timestamp ?? null, kind: 'write', before: '', after: cut(i.content) });
    }
  }
  return out.slice(-max);
}

/** 当前分支。往上找 .git；worktree 的 .git 是个文件，指向真正的 gitdir */
export function gitBranch(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i += 1) {
    const g = path.join(dir, '.git');
    try {
      const st = fs.statSync(g);
      let gitdir = g;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
        if (!m) return null;
        gitdir = path.resolve(dir, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref ? ref[1] : head.slice(0, 8);
    } catch {
      // 这一层没有，往上
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** 测试用 */
export function clearInfoCache() {
  cache.clear();
}
