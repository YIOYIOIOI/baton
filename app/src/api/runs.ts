import type { BatonEvent } from './types';

/**
 * 会话流里「一段活」：怎么分段、折叠行那句话怎么数、跑着的时候说什么。
 *
 * 原来分段在会话屏里、计数在 TurnSummary 里、「在干什么」在 useSessionLive 里，
 * 三处各认一份工具名单。挪到这里是为了能测（__tests__/runs.test.ts），也为了三处
 * **用同一套分类**：旧版 PowerShell 的图标是终端，句子里却没算成命令。
 *
 * 网页端是同一套规则的另一份（web/src/runs.ts）。两端不共享代码
 * （docs/superpowers/specs/2026-09-14-baton-desktop-web-design.md §2），
 * 所以改规则要两边一起改，两份测试的用例是一一对应的。
 *
 * ## 分段：两段正文之间的活只折成一行
 *
 * 思考算在这段活里面，不再把它切开。原来每条思考都切一刀，两段正文之间本来是一段活，
 * 会被三条思考切成了七行。两段正文之间默认折叠成一行概要。
 *
 * ## 数法：与 agent 原生习惯一致
 *
 *   读文件   按**去重后的路径**数
 *   改文件   同上。旧版按调用次数数，「改了 2 个文件」其实是同一个 script.py 改了两次
 *   命令     按次数数（bashCount）
 *   其他     **只数剩下的**。旧版写「共 N 次工具调用」是总数，命令被算了两遍——
 *            Claude 写的是「Ran a command, used 3 tools」
 */

/** 一次工具调用，配上它的结果。服务端是分开发的，按 `tool.id` 配回来 */
export type Pair = { call: BatonEvent; result?: BatonEvent };

/** 一段活里的一步 */
export type Step = { t: 'call'; pair: Pair } | { t: 'think'; event: BatonEvent };

/**
 * `ids` 是这一段盖住的全部事件。「重连后补上 N 条」那条线画在补回来的第一条前面，
 * 而那一条可能是一段活中间的某次调用、某段思考，甚至一个被吞掉的正常 turn_end——
 * 只拿每段第一条去比的话，这些情况下那条线就画不出来。
 */
export type Seg =
  | { kind: 'calls'; steps: Step[]; ids: string[] }
  | { kind: 'one'; event: BatonEvent; ids: string[] };

/* ── 分段 ─────────────────────────────────────────────────────────────────── */

type Open = { kind: 'run'; steps: Step[]; covered: BatonEvent[] };

/**
 * 两件事一起做：
 *
 * 1. **调用与结果配对**。后端把 tool_call 与 tool_result 当两个事件发（transcript
 *    里它们本来就分属不同记录行），但界面上它们是**一条**：调用是标题，结果是
 *    展开后的内容。按 tool.id 配对；配不上的结果（比如那一页恰好从中间切开）仍在
 *    这段活里自成一步，不丢掉——丢掉等于悄悄藏起一段真实发生过的输出。
 *
 * 2. **把一段活并成一行**。工具调用和思考归进当前这段；正文、中断标记、出错的
 *    turn_end 各占一行，并且把一段活切开。
 *
 * 正常结束的 turn_end 不切：一轮做完工具没写正文就结束、下一轮又接着做工具的时候，
 * 切开只会多出一条没有意义的边界。没有一段活可并时它自己一段（画出来什么都没有）。
 */
export function segment(events: BatonEvent[]): Seg[] {
  const resultOf = new Map<string, BatonEvent>();
  for (const e of events) {
    if (e.kind === 'tool_result' && e.tool?.id) resultOf.set(e.tool.id, e);
  }
  const used = new Set<string>();

  const out: (Open | Extract<Seg, { kind: 'one' }>)[] = [];
  let run: Open | null = null;

  for (const e of events) {
    let step: Step | null = null;
    switch (e.kind) {
      case 'tool_call': {
        const r = e.tool?.id ? resultOf.get(e.tool.id) : undefined;
        if (r) used.add(r.id);
        step = { t: 'call', pair: { call: e, result: r } };
        break;
      }
      case 'tool_result':
        if (used.has(e.id)) continue;            // 已经并进它的调用里了
        step = { t: 'call', pair: { call: e } }; // 落单的结果仍要显示
        break;
      case 'thinking':
        step = { t: 'think', event: e };
        break;
      case 'turn_end':
        if (!e.error && run) {
          run.covered.push(e);
          continue;
        }
        break;
      default:
        break;
    }

    if (!step) {
      run = null;
      out.push({ kind: 'one', event: e, ids: [e.id] });
      continue;
    }
    if (!run) {
      run = { kind: 'run', steps: [], covered: [] };
      out.push(run);
    }
    run.steps.push(step);
    run.covered.push(e);
    if (step.t === 'call' && step.pair.result) run.covered.push(step.pair.result);
  }

  return out.flatMap((s): Seg[] => {
    if (s.kind === 'one') return [s];
    if (s.steps.some((x) => x.t === 'call')) {
      return [{ kind: 'calls', steps: s.steps, ids: s.covered.map((e) => e.id) }];
    }
    // 只有思考、一次工具都没调的那段不折：折起来是一行「用了 0 次工具」，按原样拆回去
    return s.covered.map((e): Seg => ({ kind: 'one', event: e, ids: [e.id] }));
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
  ['AskUserQuestion', 'ask'], ['mcp__baton__ask', 'ask'], ['ask_question', 'ask'],
  ['request_user_input', 'ask'], ['request_user_input_async', 'ask'],
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
 * **老版本的 exec 本身就是一条裸命令**，那种没有 JS 的样子，照旧算命令。
 */
function execKind(code: string): Kind {
  const inner = INNER.exec(code);
  if (inner) return KINDS.get(inner[1]) ?? 'other';
  return LOOKS_JS.test(code) ? 'other' : 'shell';
}

/** Codex 的 `run` 是上网（web.run）：53 个样本全是 `search_query` / `open`。万一将来真有带 command 的，照命令算 */
function runKind(input: unknown): Kind {
  const v = coerce(input);
  if (isRecord(v) && (str(v.command) ?? str(v.cmd))) return 'shell';
  return 'web';
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

export function summarize(pairs: Pair[]): string {
  const calls = new Map<Kind, number>();
  const files = { read: new Set<string>(), edit: new Set<string>() };
  let questions = 0;

  for (const p of pairs) {
    const name = p.call.tool?.name ?? null;
    const input = p.call.tool?.input;
    const kind = kindOf(name, input);
    calls.set(kind, (calls.get(kind) ?? 0) + 1);
    if (kind === 'read' || kind === 'edit') {
      const paths = filesOf(name, input);
      // 路径取不到就按一次调用一个文件算：宁可多数一个，也别让这一步从句子里消失
      if (paths.length) for (const f of paths) files[kind].add(samePath(f));
      else files[kind].add(`#${p.call.id}`);
    }
    if (kind === 'ask') questions += Math.max(1, questionCount(input));
  }

  const parts: string[] = [];
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

/* ── 跑着的时候说什么 ─────────────────────────────────────────────────────── */

const LIVE: Record<Kind, string> = {
  read: '正在读文件', search: '正在搜索', edit: '正在改文件', shell: '正在跑命令',
  web: '正在上网查', agent: '子 agent 在干活', ask: '等你回答', other: '正在用工具',
};

/**
 * 这段活还在跑时折叠行上那句进行时。看的是**最后一步**：还没结果的调用说它是哪一类，
 * 结果回来了就是在想下一步，最后一步是思考就是在思考——旧版只看最后一次调用的名字，
 * 调用早回来了、它已经在想下一步时，这一行还是「正在跑命令」。
 */
export function liveLabel(steps: Step[]): string {
  const last = steps[steps.length - 1];
  if (!last) return '正在想下一步';
  if (last.t === 'think') return '正在思考';
  if (last.pair.result) return '正在想下一步';
  const tool = last.pair.call.kind === 'tool_call' ? last.pair.call.tool : undefined;
  if (!tool) return '正在想下一步'; // 落单的结果：它本身就是一个回来了的结果
  return LIVE[kindOf(tool.name, tool.input)];
}

/**
 * 对话末尾那行运行指示的后半句（● 0:42 · 1.2k tokens · 跑 npm test）。
 *
 * 旧版是最近一次调用的 `正在跑 ${name}(${首行})`，有两个毛病：Codex 的输入是一段 JS
 * 或一串 JSON，于是手机上是「正在跑 exec(const r = await tools.exec_command({cmd:"…」；
 * 而且只在有新调用进来时才改，之后再没人清它——命令早跑完了、agent 已经在写正文，
 * 这一行还停在那条命令上。现在每次都从事件流倒推，用人话说那一步在干什么。
 *
 * 往回找**还没有结果的那次调用**，而不是最后一次调用：并行调用时，最后一条可能早就
 * 回来了，真正还在跑的是前一条。
 */
export function doingOf(events: BatonEvent[]): string | null {
  const done = new Set<string>();
  let last: BatonEvent | null = null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.kind === 'turn_end') continue;
    last ??= e;
    if (e.kind === 'tool_result') {
      if (e.tool?.id) done.add(e.tool.id);
      continue;
    }
    if (e.kind === 'tool_call') {
      if (!e.tool?.id || !done.has(e.tool.id)) return actOf(e.tool?.name, e.tool?.input);
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
      const p = rec && (str(rec.pattern) ?? str(rec.Pattern) ?? str(rec.Query) ?? str(rec.SearchPath));
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

/* ── 成败 ─────────────────────────────────────────────────────────────────── */

/**
 * 这一步失败了没有。**只认服务端给的 `tool.failed`**：那是 agent 自己记下的成败——
 * Claude 的 is_error，Codex 结果开头的 Exit code / Script failed（docs/ops/agent-protocol.md §22）。
 *
 * 旧版在输出末尾找 error、failed、fatal 这几个词。2026-10-10 拿全量数据对过：标红的
 * 十条里将近九条是冤枉的（「errors: none」「0 failed」、网址里的 /error），真出错的又
 * 漏了一半多（「File does not exist.」一个关键词都不带）。
 *
 * 还没结果的不算失败：不知道就是不知道。
 */
export function failedOf(p: Pair): boolean {
  return (p.result ?? p.call).tool?.failed === true;
}

/* ── 单条调用那一行 ───────────────────────────────────────────────────────── */

/**
 * 单条调用那一行，工具名后面跟的那一截：哪条命令、哪个文件、搜什么、查什么。
 *
 * 旧版是「记录里挑第一个有的字段，字符串取第一行」，2026-10-10 翻实物有五处不对：
 *
 *   Codex 的入参是一串 JSON      每一次 shell_command 都显示成 {"command":"…","workdir":"…"}
 *   截断过的输入是半截 JSON      Write 大文件、很长的 Bash 显示成 {"file_path":"C:\\…
 *   apply_patch 的入参是补丁原文  只看得到第一行「*** Begin Patch」
 *   Codex 的 exec 是一段 JS      const r = await tools.exec_command({cmd:"…
 *   整条路径                    手机一行放不下，截掉的偏偏是文件名。所以只给最后两段（同网页端）
 *
 * Grep 也顺带对了：旧版先挑 path 再挑 pattern，显示的是在哪个目录里搜，不是搜什么。
 */
export function argOf(name: string | null | undefined, input: unknown): string {
  const kind = kindOf(name, input);
  const v = coerce(input);
  const rec = isRecord(v) ? v : null;
  let got: string | null = null;
  switch (kind) {
    case 'shell':
      got = commandOf(name, input);
      break;
    case 'read':
    case 'edit': {
      const files = filesOf(name, input);
      if (files.length) return files.length > 1 ? `${shortPath(files[0])} 等 ${files.length} 个文件` : shortPath(files[0]);
      break;
    }
    case 'search':
      got = rec && (str(rec.pattern) ?? str(rec.Pattern) ?? str(rec.query) ?? str(rec.Query) ?? str(rec.SearchPath));
      break;
    case 'web':
      got = webQuery(name, input, rec);
      break;
    case 'agent':
      got = rec && (str(rec.description) ?? str(rec.task_name) ?? str(rec.Role) ?? str(rec.TypeName));
      break;
    default:
      break;
  }
  if (got) return firstLine(got);
  // 其余照旧：记录里挑一个像样的字段，再不行就一截 JSON；字符串取第一行
  if (rec) {
    const first = str(rec.command) ?? str(rec.CommandLine) ?? str(rec.file_path) ?? str(rec.Path)
      ?? str(rec.TargetFile) ?? str(rec.AbsolutePath) ?? str(rec.path) ?? str(rec.pattern)
      ?? str(rec.Pattern) ?? str(rec.query) ?? str(rec.Query) ?? str(rec.url) ?? str(rec.Url);
    if (first) return firstLine(first);
    return Object.keys(rec).length ? JSON.stringify(rec).slice(0, 120) : '';
  }
  return typeof v === 'string' ? firstLine(v) : '';
}

function webQuery(name: string | null | undefined, input: unknown, rec: Record<string, unknown> | null): string | null {
  if (rec) {
    const direct = str(rec.query) ?? str(rec.Query) ?? str(rec.url) ?? str(rec.Url);
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

/* ── 小工具 ───────────────────────────────────────────────────────────────── */

/**
 * 字符串里装着 JSON 就解开它：Codex 的入参多半是这个形状（`'{"command":"…"}'`），
 * Claude 的 Write 也是。只在明显是 JSON 字面量时才试；解析失败原样返回——
 * 被截断的载荷正好落在这里，那是期望行为。
 */
export function coerce(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return v;
  try {
    const parsed: unknown = JSON.parse(s);
    return parsed !== null && typeof parsed === 'object' ? parsed : v;
  } catch {
    return v;
  }
}

/** `mcp__chrome-devtools__take_screenshot` 其实是「服务 + 方法」两段，拆开显示 */
function displayName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

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

/** 末尾两段：人认的是「哪个文件」。全路径动辄 80 字，手机一行放不下 */
function shortPath(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…${sep}${parts.slice(-2).join(sep)}`;
}

function firstLine(s: string): string {
  const t = s.trim();
  const i = t.indexOf('\n');
  return (i < 0 ? t : t.slice(0, i)).trim().slice(0, 200);
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}
