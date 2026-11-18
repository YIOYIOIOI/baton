import { modeFlags } from '../permission.js';
import { ASK_TOOL } from '../ask/protocol.js';
import { shellPath } from '../ask/setup.js';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// argv 里只允许出现程序自控的内容。用户消息一律走 stdin——
// Windows 上 claude/codex 是 .cmd 包装，必须经 shell 启动，
// 而 Node 的 DEP0190 明说「传给 shell 的参数不转义、只拼接」。
function assertId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new Error(`拒绝该会话 id：必须是标准 uuid（收到 ${JSON.stringify(id)}）`);
  }
  return id;
}

// 模型名同样进 argv，所以适用上面那条同样的规矩。只放行
// 「字母数字点横线下划线」并封顶长度：真实模型名
// （claude-sonnet-4-5-20250929、gpt-5-codex、o3）都在这个集合内，
// 而空格、引号、分号、反引号、& | > 一个都进不来。
const MODEL = /^[A-Za-z0-9._-]{1,64}$/;

/** 空值放行并返回 null（= 不传 --model，用 agent 自己的默认）；非法值抛。 */
export function assertModel(model) {
  if (model === undefined || model === null || model === '') return null;
  if (typeof model !== 'string' || !MODEL.test(model)) {
    throw new Error(`拒绝该模型名：只允许字母数字点横线下划线、最长 64（收到 ${JSON.stringify(model)}）`);
  }
  return model;
}

// 权限档位**不经过校验函数**，因为它根本不接受外来字符串：modeFlags 是查表，
// 表里没有的键返回空数组。这比「校验一个字符串再拼进 argv」更强——
// 前者是闭集，后者是「我相信我的正则写对了」。
/**
 * 思考强度。**两边都有。**
 *
 * ## 上一版这里写错了
 *
 * 原话是「只有 claude 有…codex 可取的值我没能从任何地方证实」。owner 指出来：
 * 「codex 为什么没有思考强度？明明就有，去修复」。他是对的，而我当时是**把
 * 「我没查到」写成了「它没有」**——这正是 CLAUDE.md 那条「拿不准就说拿不准，
 * 不要用推理填空」要防的事，只不过我填的是个否定。
 *
 * ## 现在的证据
 *
 *   claude  `--effort <low|medium|high|xhigh|max>`，`claude --help` 直接写着
 *   codex   `-c model_reasoning_effort=<级别>`，三条独立证据：
 *             1. `codex` 配置 schema 支持 `model_reasoning_effort` 与 `plan_mode_reasoning_effort`
 *             2. 对照实验：临时 CODEX_HOME + 打不通的 base_url + `--strict-config`，
 *                `model_reasoning_effort="high"` 过了配置校验、倒在网络层；
 *                对照组 `totally_bogus_key_xyz` 直接 `Error loading config.toml:`
 *             3. 若使用第三方供应商配置，toml 内亦可显式写 `model_reasoning_effort = "xhigh"`
 *
 * ## 可取值**逐模型不同**，所以这里不是唯一的真相
 *
 * `codex debug models` 给的是每个模型自己的 `supported_reasoning_levels`：
 * gpt-6-astra 能到 `ultra`，gpt-5.5 封顶 `xhigh`，默认值也不一样。
 * 下面这个 `EFFORTS` 是**并集**，只用来挡住乱七八糟的输入；
 * 界面上该给哪几档由 models.js 按模型给。
 *
 * 拼错了不会报错、只会静默不生效，而「设了却没生效」比「设不了」糟得多——
 * 所以这里是闭集查表，不接受外来字符串。
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function isEffort(v) {
  return typeof v === 'string' && EFFORTS.includes(v);
}

/**
 * 闭集查表，和 permission 那边同一条纪律：表里没有就返回空数组。
 *
 * codex 那条拼的是 `model_reasoning_effort=<级别>`——级别只可能来自上面那个
 * 闭集，没有任何外来字符串进 argv。
 */
function effortFlags(agent, effort) {
  if (!isEffort(effort)) return [];
  if (agent === 'claude') return ['--effort', effort];
  if (agent === 'antigravity') return effort === 'ultra' ? [] : ['--effort', effort];
  if (agent === 'codex') return ['-c', `model_reasoning_effort=${effort}`];
  return [];
}

/**
 * 提问通道的两个参数。`ask` 为空就一个字都不加——这一轮就没有这个工具。
 *
 * `--allowedTools` 只放行**这一个**工具名。实测（2026-09-24，判据是磁盘副作用）：
 * 默认档位下加了它之后 `ask` 放行，而同一轮里的 `Write` 与 `Bash` 仍被拒，
 * canary.txt 与 shell.txt 都没生成。不加的话 `ask` 本身会被拒
 * （"Claude requested permissions to use mcp__baton__ask, but you haven't granted it yet."）。
 *
 * 配置路径过一道引号：见 ask/setup.js 的 shellPath。
 */
function askFlags(ask) {
  if (!ask?.configPath) return [];
  return ['--mcp-config', shellPath(ask.configPath), '--allowedTools', ASK_TOOL];
}

export function buildClaudeArgs({ sessionId, fork = false, model, permissionMode, effort, ask }) {
  const args = ['-p', '--resume', assertId(sessionId), '--output-format', 'stream-json', '--verbose'];
  if (fork) args.push('--fork-session');
  const m = assertModel(model);
  if (m) args.push('--model', m);
  args.push(...modeFlags('claude', permissionMode));
  args.push(...effortFlags('claude', effort));
  args.push(...askFlags(ask));
  return args;
}

/**
 * 新建会话那一轮**不开提问通道**，这是故意的：createSession 会一直 await 到
 * 第一轮跑完才返回，此时客户端还停在「新建」那一屏，既没有会话 key 也没有
 * 事件流——问题推不到任何地方。开了只会换来一次 4 分钟的死等。
 */
export function buildClaudeNewArgs({ sessionId, model, permissionMode, effort }) {
  const args = ['-p', '--session-id', assertId(sessionId), '--output-format', 'stream-json', '--verbose'];
  const m = assertModel(model);
  if (m) args.push('--model', m);
  args.push(...modeFlags('claude', permissionMode));
  args.push(...effortFlags('claude', effort));
  return args;
}

// --skip-git-repo-check 是必需的：非 git 或未登记为受信任的目录下，
// codex exec 直接拒绝启动（Not inside a trusted directory ...）。
export function buildCodexArgs({ threadId, fork = false, model, permissionMode, effort }) {
  const args = ['exec', fork ? 'fork' : 'resume', assertId(threadId), '--json', '--skip-git-repo-check'];
  const m = assertModel(model);
  if (m) args.push('--model', m);
  args.push(...modeFlags('codex', permissionMode));
  args.push(...effortFlags('codex', effort));
  return args;
}

/** @param {{ model?: string | null, permissionMode?: string, effort?: string | null }} [opts] */
export function buildCodexNewArgs({ model, permissionMode, effort } = {}) {
  const args = ['exec', '--json', '--skip-git-repo-check'];
  const m = assertModel(model);
  if (m) args.push('--model', m);
  args.push(...modeFlags('codex', permissionMode));
  args.push(...effortFlags('codex', effort));
  return args;
}

const AG_TIER_ALIAS = new Set(['pro', 'flash', 'flash_lite']);

/**
 * 实测 `agy 1.5.10` 对 `pro` / `flash` / `flash_lite`、Orchestrator 以及已带后缀的模型（如
 * `gpt-oss-120b-medium`、`gemini-4-carbon-high`）传 `--effort` 会直接报 `invalid model selection`。
 * 仅未选模型或基础模型 ID 支持追加 `--effort`。
 */
export function antigravityModelSupportsEffort(model) {
  if (!model) return true;
  if (AG_TIER_ALIAS.has(model)) return false;
  if (model.startsWith('gemini-pro-orchestrator') || model.startsWith('gpt-oss-')) return false;
  if (/-(?:low|medium|high|xhigh|max)$/.test(model)) return false;
  return true;
}

export function buildAntigravityArgs({ sessionId, model = null, permissionMode = 'default', effort = null }) {
  const args = ['--input-format=stream-json', '--output-format=stream-json', '--print=', '--conversation', assertId(sessionId)];
  const m = assertModel(model);
  if (m) args.push('--model', m);
  args.push(...modeFlags('antigravity', permissionMode));
  if (antigravityModelSupportsEffort(m)) args.push(...effortFlags('antigravity', effort));
  return args;
}

/** @param {{ model?: string | null, permissionMode?: string, effort?: string | null }} [opts] */
export function buildAntigravityNewArgs({ model = null, permissionMode = 'default', effort = null } = {}) {
  const args = ['--input-format=stream-json', '--output-format=stream-json', '--print='];
  const m = assertModel(model);
  if (m) args.push('--model', m);
  args.push(...modeFlags('antigravity', permissionMode));
  if (antigravityModelSupportsEffort(m)) args.push(...effortFlags('antigravity', effort));
  return args;
}
