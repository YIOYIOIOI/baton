import type { Ev } from './api';
import { coerce, displayName, pathOf, peekOf, shortPath } from './tools.ts';

/**
 * 会话里「一段活」：怎么分段、折叠行那句话怎么数、跑着的时候状态栏说什么。
 *
 * **和 Conversation.tsx 分开是为了能测**（test/web-runs.test.js）——这里是纯函数，
 * 不碰 DOM、不 import css，Node 24 直接 import 这个 .ts 就能跑。sessions.ts 是同一个理由。
 *
 * ## 分段：两段正文之间的活只折成一行
 *
 * 思考算在这段活里面，不再把它切开。原来每条思考都切一刀，两段正文之间本来是一段活，
 * 会被三条思考切成了七行。
 *
 * 结构上与主流 CLI/桌面端对齐：读 / 搜 / 改按统一语义计数与统计思考时长，
 * 两段正文之间只折成一行概要。
 *
 * ## 数法：与 agent 原生习惯一致
 *
 *   读文件   按**去重后的路径**数
 *   改文件   同上。旧版按调用次数数，「改了 2 个文件」其实是同一个 script.py 改了两次
 *   命令     按次数数（bashCount）
 *   其他     **只数剩下的**。旧版写「共 N 次工具调用」是总数，命令被算了两遍——
 *            「跑了 1 条命令、共 4 次」其实是 1 次 Bash + 3 次别的，Claude 写的是
 *            「Ran a command, used 3 tools」
 *
 * 珠子和这句话**用同一套分类**（kindOf）。旧版珠子看 tools.ts 的 family()、句子自己
 * 列了一份名单，两边对不上：PowerShell 画成命令的三角，句子里却没算成命令。
 */

export type ToolCall = Extract<Ev, { kind: 'tool_call' }>;
export type ToolResult = Extract<Ev, { kind: 'tool_result' }>;
export type Thinking = Extract<Ev, { kind: 'thinking' }>;

/** 一次工具调用，配上它的结果。服务端是分开发的，按 `tool.id` 配回来 */
export type Tool = { id: string; call: ToolCall; result?: ToolResult };

/** 一段活里的一步 */
export type Step = { t: 'tool'; tool: Tool } | { t: 'think'; ev: Thinking };

export type Run = { t: 'run'; id: string; steps: Step[] };
export type Item = { t: 'ev'; ev: Ev } | Run;

/* ── 分段 ─────────────────────────────────────────────────────────────────── */

/**
 * 正文、中断标记、出错的 turn_end 各占一行，并且把一段活切开；工具调用和思考归进当前这段。
 *
 * 正常结束的 turn_end 既不占行也不切：它对读者没有信息，而一轮做完工具没写正文就结束、
 * 下一轮又接着做工具的时候，切开只会多出一条没有意义的边界。
 *
 * 配不上对的结果（tool.id 缺了）自己一行——总比错配到别人身上强，也不能吞掉。
 */
export function group(events: Ev[]): Item[] {
  const out: Item[] = [];
  const byId = new Map<string, Tool>();
  let run: Run | null = null;

  const add = (step: Step, id: string) => {
    if (!run) {
      run = { t: 'run', id, steps: [] };
      out.push(run);
    }
    run.steps.push(step);
  };
  const alone = (ev: Ev) => {
    run = null;
    out.push({ t: 'ev', ev });
  };

  for (const ev of events) {
    switch (ev.kind) {
      case 'tool_call': {
        const tool: Tool = { id: ev.id, call: ev };
        if (ev.tool?.id) byId.set(ev.tool.id, tool);
        add({ t: 'tool', tool }, ev.id);
        break;
      }
      case 'tool_result': {
        const mine = ev.tool?.id ? byId.get(ev.tool.id) : undefined;
        if (mine) mine.result = ev;
        else alone(ev);
        break;
      }
      case 'thinking':
        add({ t: 'think', ev }, ev.id);
        break;
      case 'turn_end':
        if (ev.error) alone(ev);
        break;
      default:
        alone(ev);
    }
  }

  // 只有思考、一次工具都没调的那段不折：折起来是一行「用了 0 次工具」，拆回一条条思考
  return out.flatMap((it): Item[] => {
    if (it.t !== 'run' || it.steps.some((s) => s.t === 'tool')) return [it];
    return it.steps.flatMap((s): Item[] => (s.t === 'think' ? [{ t: 'ev', ev: s.ev }] : []));
  });
}

/* ── 分类 ─────────────────────────────────────────────────────────────────── */

export type Kind = 'read' | 'search' | 'edit' | 'shell' | 'web' | 'agent' | 'ask' | 'other';

/**
 * 工具名 → 类别。名单取自 2026-10-10 全量统计（两个 agent 的全部 transcript），不是照文档列的：
 *
 *   claude   Bash 38232 · Edit 9235 · Write 5462 · Read 4807 · PowerShell 865 · WebSearch 459 ·
 *            WebFetch 393 · Agent 343 · Grep 334 · AskUserQuestion 246 · Glob 17 · 其余 mcp__* 长尾
 *   codex    exec 11718 · shell_command 5624 · apply_patch 916 · spawn_agent 105 · run 53 · …
 *
 * `exec` 和 `run` 不在表里，见 kindOf。
 */
const KINDS = new Map<string, Kind>([
  ['Read', 'read'], ['NotebookRead', 'read'],
  ['read_file', 'read'], ['view_file', 'read'], ['view_file_outline', 'read'], ['view_code_item', 'read'],
  ['Grep', 'search'], ['Glob', 'search'],
  ['grep_search', 'search'], ['code_search', 'search'], ['find_by_name', 'search'], ['list_dir', 'search'],
  ['Edit', 'edit'], ['MultiEdit', 'edit'], ['Write', 'edit'], ['NotebookEdit', 'edit'], ['apply_patch', 'edit'],
  ['edit_file', 'edit'], ['write_file', 'edit'], ['replace_file_content', 'edit'], ['multi_replace_file_content', 'edit'],
  ['Bash', 'shell'], ['PowerShell', 'shell'],
  ['shell', 'shell'], ['shell_command', 'shell'], ['exec_command', 'shell'], ['local_shell', 'shell'],
  ['run_command', 'shell'], ['send_command_input', 'shell'],
  ['WebSearch', 'web'], ['WebFetch', 'web'], ['web_search', 'web'], ['web__run', 'web'],
  ['search_web', 'web'], ['read_url_content', 'web'],
  // 只有「派出去」算子 agent。Codex 的 wait_agent / send_message 之类是调度，算其他
  ['Agent', 'agent'], ['Task', 'agent'], ['spawn_agent', 'agent'], ['invoke_subagent', 'agent'],
  ['AskUserQuestion', 'ask'], ['mcp__baton__ask', 'ask'],
  ['request_user_input', 'ask'], ['request_user_input_async', 'ask'], ['ask_question', 'ask'],
]);

export function kindOf(name: string | null | undefined, input: unknown): Kind {
  if (!name) return 'other';
  if (name === 'exec') return execKind(text(input));
  if (name === 'run') return runKind(input);
  return KINDS.get(name) ?? 'other';
}

/** JS 格子里调的第一个工具。实测 11718 个格子里 98% 只调一种 */
const INNER = /\btools\.([A-Za-z_]\w*)\s*\(/;
const LOOKS_JS = /\b(?:await|const|let)\s|\bALL_TOOLS\b|\btext\(|=>/;

/**
 * Codex 的 `exec` **不是一条命令，是一段 JS**（code mode）：
 * `await tools.exec_command({cmd:"Get-Content …"})`、`await tools.web__run({search_query:…})`、
 * `await tools.apply_patch("*** Begin Patch…")`。所以按里面调的那个工具分，
 * 旧版一律当命令，上网和改文件都被数成了「跑了 N 条命令」。
 *
 * 一个工具都不调的那 78 个，是在 JS 里翻工具清单（`ALL_TOOLS.filter(…)`），算其他。
 * **老版本的 exec 本身就是一条裸命令**（tools.ts 的用例里还留着 `Get-Process -Name claude`），
 * 那种没有 JS 的样子，照旧算命令。
 */
function execKind(code: string): Kind {
  const inner = INNER.exec(code);
  if (inner) return KINDS.get(inner[1]) ?? 'other';
  return LOOKS_JS.test(code) ? 'other' : 'shell';
}

/**
 * Codex 的 `run` 是上网（web.run）：53 个样本全是 `search_query` / `open`。
 * tools.ts 原来把它当成命令——那条依据是「实测 10 次」，但没看过输入长什么样。
 * 万一将来真有带 command 的，照命令算。
 */
function runKind(input: unknown): Kind {
  const v = coerce(input);
  if (isRecord(v) && (str(v.command) ?? str(v.cmd))) return 'shell';
  return 'web';
}

/** 珠子的形状。读和搜是一类（看了看），上网、子 agent 和其他工具同画成一个点 */
export type Bead = 'read' | 'edit' | 'shell' | 'ask' | 'other';

export function beadOf(kind: Kind): Bead {
  switch (kind) {
    case 'read':
    case 'search':
      return 'read';
    case 'edit':
    case 'shell':
    case 'ask':
      return kind;
    default:
      return 'other';
  }
}

/* ── 这一步碰了哪些文件 ───────────────────────────────────────────────────── */

/**
 * apply_patch 补丁里的文件头。补丁可能是原文（换行是真换行），也可能写在 exec 那段 JS 的
 * 字符串里（换行是字面量 `\n`）。后一种情况下，Windows 路径里的反斜杠也被转义成了 `\\`，
 * 所以字面量 `\n` 只在**前面不是反斜杠**时才算行尾——不然 `C:\\node_modules` 会在 `\n` 处断开。
 */
const PATCH_FILE = /\*\*\* (?:Add|Update|Delete) File: (.+?)(?=(?<!\\)\\n|\r?\n|"|$)/g;

function filesOf(name: string | null | undefined, input: unknown): string[] {
  if (name === 'apply_patch' || name === 'exec') {
    return [...text(input).matchAll(PATCH_FILE)].map((m) => m[1].trim());
  }
  const v = coerce(input);
  if (isRecord(v)) {
    const p = str(v.file_path) ?? str(v.notebook_path) ?? str(v.Path) ?? str(v.TargetFile) ?? str(v.AbsolutePath);
    return p ? [p] : [];
  }
  // 截断过的输入是一段半截 JSON（src/wire.js 截断时先 stringify 再切），路径在开头，抠出来
  const m = /"(?:file_path|notebook_path|Path|TargetFile|AbsolutePath)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text(input));
  return m ? [unquote(m[1])] : [];
}

/** 大小写和斜杠方向不同也是同一个文件：Windows 上 `C:\` 与 `c:/` 并存（实测） */
function samePath(p: string): string {
  return p.trim().replace(/[\\/]+/g, '/').toLowerCase();
}

function questionCount(input: unknown): number {
  const v = coerce(input);
  return isRecord(v) && Array.isArray(v.questions) ? v.questions.length : 1;
}

/* ── 折叠行那句话 ─────────────────────────────────────────────────────────── */

/** 先后固定：看了看 → 动手改 → 跑起来验，正是一段活通常的顺序。其他永远在最后 */
const ORDER: Kind[] = ['read', 'search', 'edit', 'shell', 'web', 'agent', 'ask', 'other'];

export function summarize(tools: Tool[], locale: 'en' | 'zh' = 'zh'): string {
  const calls = new Map<Kind, number>();
  const files = { read: new Set<string>(), edit: new Set<string>() };
  let questions = 0;

  for (const t of tools) {
    const name = t.call.tool?.name ?? null;
    const input = t.call.tool?.input;
    const kind = kindOf(name, input);
    calls.set(kind, (calls.get(kind) ?? 0) + 1);
    if (kind === 'read' || kind === 'edit') {
      const paths = filesOf(name, input);
      // 路径取不到就按一次调用一个文件算：宁可多数一个，也别让这一步从句子里消失
      if (paths.length) for (const p of paths) files[kind].add(samePath(p));
      else files[kind].add(`#${t.id}`);
    }
    if (kind === 'ask') questions += Math.max(1, questionCount(input));
  }

  const parts: string[] = [];
  if (locale === 'en') {
    const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);
    for (const kind of ORDER) {
      const n = calls.get(kind);
      if (!n) continue;
      switch (kind) {
        case 'read': parts.push(`Read ${plural(files.read.size, 'file', 'files')}`); break;
        case 'search': parts.push(`Searched ${n}x`); break;
        case 'edit': parts.push(`Edited ${plural(files.edit.size, 'file', 'files')}`); break;
        case 'shell': parts.push(`Ran ${plural(n, 'command', 'commands')}`); break;
        case 'web': parts.push(`Searched web ${n}x`); break;
        case 'agent': parts.push(`Spawned ${plural(n, 'subagent', 'subagents')}`); break;
        case 'ask': parts.push(`Asked ${plural(questions, 'question', 'questions')}`); break;
        default: parts.push(parts.length ? `Used ${plural(n, 'other tool', 'other tools')}` : `Used ${plural(n, 'tool', 'tools')}`);
      }
    }
    return parts.join(' · ');
  }

  for (const kind of ORDER) {
    const n = calls.get(kind);
    if (!n) continue;
    switch (kind) {
      case 'read': parts.push(`读了 ${files.read.size} 个文件`); break;
      case 'search': parts.push(`搜了 ${n} 次`); break;
      case 'edit': parts.push(`改了 ${files.edit.size} 个文件`); break;
      case 'shell': parts.push(`跑了 ${n} 条命令`); break;
      case 'web': parts.push(`上网查了 ${n} 次`); break;
      case 'agent': parts.push(`派了 ${n} 个子 agent`); break;
      case 'ask': parts.push(`问了你 ${questions} 个问题`); break;
      default: parts.push(parts.length ? `用了 ${n} 次其他工具` : `用了 ${n} 次工具`);
    }
  }
  return parts.join('、');
}

/* ── 跑着的时候，状态栏说它在干什么 ───────────────────────────────────────── */

/**
 * 状态栏那一行的后半句。owner 当初的原话：跑着的时候「这一行显示各种运行状态
 * （开始、正在读写文件…）」。
 *
 * 旧版是最近一次调用的 `Name(JSON.stringify(input))` 前 48 个字，于是状态栏上是
 * `Bash({"command":"cd /c/workspace/project-a &`——半截 JSON。现在用人类可读的动作摘要。
 *
 * 往回找**还没有结果的那次调用**，而不是最后一次调用：并行调用时，最后一条可能早就
 * 回来了，真正还在跑的是前一条。
 */
export function doingOf(events: Ev[]): string | null {
  const done = new Set<string>();
  let last: Ev | null = null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.kind === 'turn_end') continue;
    last ??= ev;
    if (ev.kind === 'tool_result') {
      if (ev.tool?.id) done.add(ev.tool.id);
      continue;
    }
    if (ev.kind === 'tool_call') {
      if (!ev.tool?.id || !done.has(ev.tool.id)) return actOf(ev.tool?.name, ev.tool?.input);
      continue;
    }
    break; // 正文、思考、中断：这段活到头了
  }

  if (!last) return null;
  switch (last.kind) {
    case 'thinking': return '在思考';
    case 'tool_result': return '在想下一步';
    case 'text': return last.role === 'user' ? '刚开始' : '在想下一步';
    default: return null;
  }
}

function actOf(name: string | null | undefined, input: unknown): string {
  const kind = kindOf(name, input);
  const v = coerce(input);
  const rec = isRecord(v) ? v : null;
  switch (kind) {
    case 'shell': {
      const c = commandOf(name, input);
      return c ? `跑 ${oneLine(c)}` : '跑命令';
    }
    case 'read':
    case 'edit': {
      const f = filesOf(name, input)[0];
      const verb = kind === 'read' ? '读' : '改';
      return f ? `${verb} ${leaf(f)}` : `${verb}文件`;
    }
    case 'search': {
      const p = rec && (str(rec.pattern) ?? str(rec.Query) ?? str(rec.Pattern) ?? str(rec.SearchPath));
      return p ? `搜 ${oneLine(p)}` : '搜索';
    }
    case 'web': {
      const q = webQuery(name, input, rec);
      return q ? `上网查 ${oneLine(q)}` : '上网查';
    }
    case 'agent': {
      const d = rec && (str(rec.description) ?? str(rec.task_name) ?? str(rec.Role) ?? str(rec.TypeName));
      return d ? `派子 agent：${oneLine(d)}` : '派子 agent';
    }
    case 'ask':
      return '等你回答';
    default:
      return name ? `用 ${displayName(name)}` : '在用工具';
  }
}

function commandOf(name: string | null | undefined, input: unknown): string | null {
  if (name === 'exec') {
    const code = text(input);
    const m = /\btools\.\w+\(\s*\{[\s\S]*?\b(?:cmd|command)\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(code);
    if (m) return unquote(m[1]);
    return INNER.test(code) || LOOKS_JS.test(code) ? null : code; // 老版本：exec 就是命令本身
  }
  const v = coerce(input);
  if (isRecord(v)) return str(v.command) ?? str(v.cmd) ?? str(v.CommandLine);
  if (typeof v !== 'string' || !v) return null;
  // 解不开又以 { 开头的，是截断过的半截 JSON（src/wire.js 先 stringify 再切）：命令在开头，抠出来
  return v.trimStart().startsWith('{') ? (cutField(v, 'command|cmd|CommandLine') ?? v) : v;
}

function webQuery(name: string | null | undefined, input: unknown, rec: Record<string, unknown> | null): string | null {
  if (rec) {
    const direct = str(rec.query) ?? str(rec.url) ?? str(rec.Url);
    if (direct) return direct;
    const first = (k: string, f: string) => {
      const arr = rec[k];
      return Array.isArray(arr) && isRecord(arr[0]) ? str(arr[0][f]) : null;
    };
    return first('search_query', 'q') ?? first('open', 'ref_id');
  }
  if (name === 'exec') {
    const m = /\bq\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text(input));
    return m ? unquote(m[1]) : null;
  }
  return null;
}

/* ── 单条调用那一行 ───────────────────────────────────────────────────────── */

/**
 * 单条调用那一行，工具名后面的那一截，和悬停时给的全路径。
 *
 * 结构化的输入交给 tools.ts 的 peekOf / pathOf——那一套已经够好。**字符串**形状的有三种
 * 它认不出，只能原样取第一行（2026-10-10 翻实物）：
 *
 *   截断过的半截 JSON      Write {"file_path":"C:\\workspace\\…（src/wire.js 先 stringify 再切）
 *   apply_patch 的补丁原文  「*** Begin Patch」
 *   Codex 的 exec          「const r = await tools.exec_command({cmd:"…」
 *
 * 这三种按类别取：改了哪些文件、哪条命令、查什么——和折叠行那句话、状态栏用的是同一份
 * 认法（filesOf / commandOf / webQuery）。取不到再退回 peekOf。
 */
export function peekFor(name: string | null | undefined, input: unknown): { text: string; path: string | null } {
  if (typeof coerce(input) === 'string') {
    const kind = kindOf(name, input);
    if (kind === 'read' || kind === 'edit') {
      const files = filesOf(name, input);
      if (files.length) {
        const first = shortPath(files[0]);
        return { text: files.length > 1 ? `${first} 等 ${files.length} 个文件` : first, path: files[0] };
      }
    }
    const got = kind === 'shell' ? commandOf(name, input) : kind === 'web' ? webQuery(name, input, null) : null;
    if (got) return { text: oneLine(got), path: null };
  }
  return { text: peekOf(name, input), path: pathOf(input) };
}

/* ── 小工具 ───────────────────────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** JSON 字符串字面量里的转义还原回来；还原不了就原样 */
function unquote(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

/** 半截 JSON 里抠一个字符串字段。值本身也可能被截断了，所以不要求有收尾的引号 */
function cutField(s: string, keys: string): string | null {
  const m = new RegExp(`"(?:${keys})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(s);
  return m ? unquote(m[1].replace(/\\$/, '')) : null;
}

function leaf(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}
