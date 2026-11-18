/**
 * 把各家 agent 的工具载荷整形成界面能直接渲染的几段。
 *
 * 这一层存在的理由，全部是实测出来的（跨 48 个会话、1371 个 tool_call、958 个
 * tool_result 抽样）。**载荷的形状在两个 agent 之间、甚至同一个 agent 内部都不统一**，
 * 而原来的渲染是一句 `JSON.stringify(v, null, 2)` 通吃：
 *
 * | 实测 | 直接 stringify 的后果 |
 * |---|---|
 * | claude `Bash` **436 次**，input 是 `{command, description}` | 命令被埋进 JSON，命令里的换行以字面 `\n` 显示，整块挤成一行横滚 |
 * | claude `Edit` 117 次，input 是 `{file_path, old_string, new_string}` | 本质是一次替换，却显示成两坨转义字符串 |
 * | claude `Write` 48 次，input 是**字符串装 JSON**（不是对象） | 一整行转义串 |
 * | codex `exec` **405 次**，input 多半是**裸字符串**（就是命令本身） | 尚可，但 17% 是字符串装 JSON，那部分同样是一行转义串 |
 * | claude 约 10% 的 output 是 `[{"type":"text","text":"…"}]` | 正文被包在 JSON 数组里，`\n` 全部可见 |
 *
 * 四个家族（shell / edit / write / read）覆盖 84% 的调用；其余走通用整形——
 * 通用那条本身就是大头收益：**对象的每个键各成一段，字符串值原样输出（真换行）**，
 * 不再经过一次 JSON 转义。
 *
 * ## 截断会把类型也改掉
 *
 * `src/wire.js:25` 截断时做的是 `JSON.stringify(value)` 再切片，所以**一个被截断的
 * 对象载荷回到客户端时已经是一段破 JSON 字符串**（实测约 5% 的调用会触发）。
 * 这里不做任何补救式的猜测：解析失败就当普通文本原样显示，并由调用方挂上「看全文」。
 * 等全文取回来（它是完整的 `JSON.stringify` 输出）再整形，同一条代码路径自然生效。
 */

/** 展开后的一段。渲染层只认这个结构，不认任何 agent 的原始字段。 */
export type Section = {
  /**
   * 段小标题。**每段都有名字，且只有这一层标题**——原来是「输入」外层标题套一坨
   * JSON，读者要先解析 JSON 才知道自己在看什么。现在标题直接说出来：一条 Bash
   * 调用的那段叫「命令」，一次 Edit 的两段叫「删去」「换成」。
   */
  label: string;
  text: string;
  /**
   * code   —— 等宽保留换行，命令 / 代码 / 终端输出都用它
   * inline —— 标题与值同一行。短标量（`timeout: 300000`、`pageId: 1`）占一个
   *            带内边距的代码块纯属浪费——MCP 工具的参数大半是这种
   * note   —— 给人读的说明（如 Bash 的 description），正文字体
   * del / ins —— 一次替换的两侧
   */
  kind: 'code' | 'inline' | 'note' | 'del' | 'ins';
};

/* ── 形状归一 ─────────────────────────────────────────────────────────────── */

/**
 * 字符串里装着 JSON 就解开它。
 *
 * 必要性是实测的：codex 17% 的 input、claude 全部的 `Write` 都是这个形状。
 * 只在明显是 JSON 字面量时才试——否则一条以 `{` 开头的普通命令会被白白 parse 一次。
 * 解析失败原样返回：被截断的载荷正好落在这里，而那是**期望行为**，不是异常。
 */
export function coerce(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return v;
  try {
    const parsed = JSON.parse(s);
    // 解析出标量没有意义（`"123"` → 123），那不是「装着 JSON」
    return parsed !== null && typeof parsed === 'object' ? parsed : v;
  } catch {
    return v;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 值转文本。字符串原样（保住真换行），其余才 stringify。 */
export function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/* ── 工具名 ───────────────────────────────────────────────────────────────── */

/**
 * `mcp__chrome-devtools__evaluate_script` 这种名字会把折叠行占满，
 * 而它其实是「服务 + 方法」两段。拆开显示，信息一点没少，长度减半。
 */
export function displayName(name: string | null | undefined): string {
  if (!name) return '工具';
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

export type Family = 'shell' | 'edit' | 'write' | 'read' | 'ask' | 'other';

/**
 * 提问类工具。两个来源，形状不同，但读者眼里是同一件事：
 *
 *   `AskUserQuestion`    Claude **交互式**界面里那个选项框。本机 transcript 里
 *                        167 次。Baton 自己跑的轮次拿不到它（`-p` 模式下不存在，
 *                        见 src/ask/protocol.js），但**在电脑上继续同一条会话时
 *                        会出现**，而 Baton 读的是同一份 transcript。
 *                        入参是 `{questions:[{question, header, multiSelect, options}]}`
 *   `mcp__baton__ask`    Baton 自己那个。入参是 `{question, options, multiSelect}`
 *
 * 不整形的话，前者在手机上就是一坨 `{"questions":[{"question":"梵净山要不要安排？"…`
 * 的转义 JSON——那 167 条每一条都是。
 */
const ASK_TOOLS = new Set(['AskUserQuestion', 'mcp__baton__ask', 'ask_question']);

type AskQ = {
  question: string; header?: string; multiSelect?: boolean; is_multi_select?: boolean; options?: unknown[];
};

function askQuestions(v: Record<string, unknown>): AskQ[] {
  if (Array.isArray(v.questions)) {
    return v.questions.filter(isRecord).map((q) => q as unknown as AskQ);
  }
  if (typeof v.question === 'string') return [v as unknown as AskQ];
  return [];
}

function askSections(v: Record<string, unknown>): Section[] {
  const qs = askQuestions(v);
  if (!qs.length) return [];
  const out: Section[] = [];
  for (const q of qs) {
    out.push({ label: q.header?.trim() || '问题', text: String(q.question ?? ''), kind: 'note' });
    const opts = Array.isArray(q.options) ? q.options : [];
    opts.forEach((o, i) => {
      const label = typeof o === 'string' ? o : (isRecord(o) && typeof o.label === 'string' ? o.label : '');
      if (!label) return;
      const desc = isRecord(o) && typeof o.description === 'string' ? o.description : '';
      out.push({
        label: `选项 ${i + 1}`,
        text: desc ? `${label} —— ${desc}` : label,
        kind: 'note',
      });
    });
    if (q.multiSelect === true || q.is_multi_select === true) out.push({ label: '可多选', text: '是', kind: 'inline' });
  }
  return out;
}

/**
 * 工具名 → 家族。名单取自线上实测的调用次数，不是照着文档列的：
 *
 *   claude   Bash 436 · Edit 117 · Write 48 · Read 37 · PowerShell 29 · 其余 mcp__* 长尾
 *   codex    exec 405 · shell_command 65 · run 10 · 其余个位数
 *
 * 这四格占 84%。长尾一律走通用整形——为个位数的工具各写一条规则，
 * 维护成本立刻超过收益，而通用那条已经够好。
 *
 * **这里只管展开后怎么排版。** 时间线上的珠子和折叠行那句话按 runs.ts 的 kindOf 分——
 * 那边要数次数，得看得更细（Codex 的 exec 是一段 JS，要看它里面调的是谁）。
 *
 * `run` 原来也在 shell 里，依据是「实测 10 次」，但没看过输入：2026-10-10 翻了
 * 全部 53 次，全是 `search_query` / `open`——它是 Codex 的上网（web.run），不是命令。
 */
export function family(name: string | null | undefined): Family {
  if (name && ASK_TOOLS.has(name)) return 'ask';
  switch (name) {
    case 'Bash':
    case 'PowerShell':
    case 'exec':
    case 'shell_command':
    case 'run_command':
      return 'shell';
    case 'Edit':
    case 'edit_file':
    case 'replace_file_content':
      return 'edit';
    case 'Write':
    case 'write_file':
      return 'write';
    case 'Read':
    case 'read_file':
    case 'view_file':
    case 'view_file_outline':
    case 'view_code_item':
      return 'read';
    default:
      return 'other';
  }
}

/* ── 路径 ─────────────────────────────────────────────────────────────────── */

/** 末尾两段。绝对路径动辄 80 字，而人认的是「哪个文件」。全路径留给 title。 */
export function shortPath(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…${p.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(p.includes('\\') ? '\\' : '/')}`;
}

/* ── 输入 ─────────────────────────────────────────────────────────────────── */

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

/** 单行且不长的值收成一行——超过这个长度就值得自己占一块。 */
const INLINE_MAX = 72;

/** 通用整形：对象的每个键各成一段，键名就是段标题，字符串值原样。 */
function fields(o: Record<string, unknown>): Section[] {
  const out: Section[] = [];
  for (const [k, v] of Object.entries(o)) {
    // 空值不占版面。false 一并略过：`replace_all: false` 是「没开」，不是一条信息
    if (v == null || v === '' || v === false) continue;
    const text = asText(v);
    const inline = !text.includes('\n') && text.length <= INLINE_MAX;
    out.push({ label: k, text, kind: inline ? 'inline' : 'code' });
  }
  return out;
}

export function shapeInput(name: string | null | undefined, raw: unknown): Section[] {
  const v = coerce(raw);

  // 裸字符串就是内容本身——codex 的 `exec` 八成如此，截断后的载荷也落在这里
  if (typeof v === 'string') {
    return v ? [{ label: '输入', text: v, kind: 'code' }] : [];
  }
  if (!isRecord(v)) {
    const t = asText(v);
    return t ? [{ label: '输入', text: t, kind: 'code' }] : [];
  }

  switch (family(name)) {
    case 'shell': {
      const cmd = str(v, 'command') ?? str(v, 'cmd') ?? str(v, 'CommandLine') ?? str(v, 'code') ?? str(v, 'script');
      if (cmd === null) break; // 形状不合预期就退回通用，不硬凑
      const out: Section[] = [{ label: '命令', text: cmd, kind: 'code' }];
      const desc = str(v, 'description') ?? str(v, 'toolSummary');
      if (desc) out.push({ label: '说明', text: desc, kind: 'note' });
      // 其余键（timeout、run_in_background…）照通用规则补上，不为它们单开条款
      const rest = { ...v };
      delete rest.command; delete rest.cmd; delete rest.CommandLine;
      delete rest.code; delete rest.script; delete rest.description; delete rest.toolSummary;
      out.push(...fields(rest));
      return out;
    }

    case 'edit': {
      const before = str(v, 'old_string') ?? str(v, 'Target') ?? str(v, 'TargetContent');
      const after = str(v, 'new_string') ?? str(v, 'Replacement') ?? str(v, 'ReplacementContent');
      if (before === null || after === null) break;
      const out: Section[] = [
        { label: '删去', text: before, kind: 'del' },
        { label: '换成', text: after, kind: 'ins' },
      ];
      if (v.replace_all === true) out.push({ label: '范围', text: '全部替换', kind: 'note' });
      return out;
    }

    case 'write': {
      const content = str(v, 'content') ?? str(v, 'Content');
      if (content === null) break;
      return [{ label: '内容', text: content, kind: 'code' }];
    }

    case 'read': {
      // 路径已经在折叠行上了，这里只补「读了哪一段」之类的附加项
      const rest = { ...v };
      delete rest.file_path; delete rest.Path; delete rest.AbsolutePath;
      return fields(rest);
    }

    case 'ask': {
      const out = askSections(v);
      if (!out.length) break; // 形状不合预期就退回通用，不硬凑
      return out;
    }
  }

  return fields(v);
}

/* ── 输出 ─────────────────────────────────────────────────────────────────── */

/**
 * Claude 的工具结果有约 10% 是 `[{"type":"text","text":"…"}]`——MCP 的内容块格式。
 * 不拆开的话正文被包在 JSON 数组里，换行全部以 `\n` 字面量显示，等于读不了。
 * 非 text 的块（image 之类）只留一行占位，不假装能显示它。
 */
function contentBlocks(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const parts: string[] = [];
  for (const b of v) {
    if (!isRecord(b) || typeof b.type !== 'string') return null; // 不是内容块数组
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else parts.push(`[${b.type}]`);
  }
  return parts.join('\n');
}

export function shapeOutput(raw: unknown): Section[] {
  const v = coerce(raw);
  const blocks = contentBlocks(v);
  if (blocks !== null) return blocks ? [{ label: '输出', text: blocks, kind: 'code' }] : [];
  if (isRecord(v)) return fields(v);
  const t = asText(v);
  return t ? [{ label: '输出', text: t, kind: 'code' }] : [];
}

/* ── 折叠行的一句话 ───────────────────────────────────────────────────────── */

const PEEK_MAX = 160;

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > PEEK_MAX ? `${t.slice(0, PEEK_MAX)}…` : t;
}

/**
 * 折叠状态下那一行。**它必须是人话**——原来这里是 `JSON.stringify` 的前 160 字，
 * 于是满屏 `{ "command": "echo \"===` 这样的转义开头，既认不出是哪条命令，
 * 也占满了整行。
 *
 * 文件类工具给路径（人是靠「哪个文件」认的），其余给内容首行。
 */
export function peekOf(name: string | null | undefined, raw: unknown): string {
  const v = coerce(raw);

  // 提问类工具的一句话就是问题本身——那正是读者想知道的「它问了什么」
  if (isRecord(v) && family(name) === 'ask') {
    const qs = askQuestions(v);
    if (qs.length) return oneLine(qs.map((q) => String(q.question ?? '')).join(' / '));
  }

  if (isRecord(v)) {
    const path = str(v, 'file_path') ?? str(v, 'path') ?? str(v, 'Path')
      ?? str(v, 'TargetFile') ?? str(v, 'AbsolutePath') ?? str(v, 'notebook_path');
    if (path && family(name) !== 'shell') return shortPath(path);
  }

  const first = shapeInput(name, raw).find((s) => s.kind === 'code' || s.kind === 'del');
  return first ? oneLine(first.text) : '';
}

/** 折叠行上给 title 用的全路径。没有路径就不给，免得挂一个空 tooltip。 */
export function pathOf(raw: unknown): string | null {
  const v = coerce(raw);
  if (!isRecord(v)) return null;
  return str(v, 'file_path') ?? str(v, 'path') ?? str(v, 'Path')
    ?? str(v, 'TargetFile') ?? str(v, 'AbsolutePath') ?? str(v, 'notebook_path');
}
