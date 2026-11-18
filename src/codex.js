import { makeEvent } from './events.js';
import { scanForward } from './jsonl.js';

const PLUGIN_MENTION = /^\s*\[@[^\]]+\]\(plugin:\/\/[^)]*\)\s*/;
// 合成前言的标签一律小写蛇形或短横线式（environment_context / recommended_plugins / app-context）。
// 真实用户输入极少以这种标签开头。
const OPEN_TAG = /^<([a-z][a-z0-9_-]*)[\s>]/;

// Codex 的浏览器插件与附件走另一种包装：Markdown 井号式，尖括号判据认不出。
// 实测全语料 8 条标题被它污染（2 条 Chrome tabs、6 条 Files mentioned），
// 且全在 Codex 侧——Claude 侧一条都没有。
// 白名单而非「凡井号开头皆前言」：真实用户正文完全可能以 # 开头写标题。
const HASH_PREAMBLE =
  /^#+\s*(Chrome tabs|Files mentioned by the user|Current working|AGENTS\.md instructions|System|Context)\b/i;

// 注入块里常夹着真实请求，形如：
//   # Chrome tabs:
//   - Current URL: ...
//   ## My request:
//   这个第十题，一般是多少轮啊
// 能抢救就抢救——直接降级为「未命名会话」会扔掉本来拿得到的标题。
const USER_REQUEST = /##\s*My request:\s*([\s\S]+)/i;

export function extractUserRequest(text) {
  const s = String(text ?? '');
  if (!HASH_PREAMBLE.test(s.trimStart())) return null; // 非注入块不归它管
  const m = USER_REQUEST.exec(s);
  const body = m ? m[1].trim() : '';
  return body || null;
}

/**
 * 工具结果开头那行自己写着的成败（docs/ops/agent-protocol.md §22）：
 *
 *   shell_command / apply_patch   `Exit code: N`。不是 0 就是失败——负数也是（Windows 的异常码，实测 11 条）
 *   exec（code mode）             `Script completed / running / failed / terminated`。
 *                                 running 是还没跑完（结果要等 wait），不算失败；terminated 是被中途杀掉，算
 *
 * 只看开头，不看正文：正文里的 error、fatal 是命令打印出来的东西，不是它的成败。
 */
const FAILED_HEAD = /^(?:Exit code: (?!0\b)-?\d+|Script (?:failed|terminated)\b)/;

export function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'input_text' || b?.type === 'output_text' || b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

export function isSyntheticPreamble(text) {
  const s = String(text ?? '').trimStart();
  return OPEN_TAG.test(s) || HASH_PREAMBLE.test(s);
}

export function stripPluginMention(text) {
  return String(text ?? '').replace(PLUGIN_MENTION, '').trim();
}

export function codexHead(records) {
  const meta = records.find((r) => r?.type === 'session_meta')?.payload ?? {};
  return {
    cwd: meta.cwd ?? null,
    cliVersion: meta.cli_version ?? null,
    contextWindow: meta.context_window ?? null,
    originator: meta.originator ?? null,
    source: meta.source ?? null,
    // 'user' = 真会话；'subagent' / 'guardian_review' = 内部运行，不该出现在会话列表里。
    // 实测 148 个 rollout：subagent 110、user 37、guardian_review 1。
    threadSource: meta.thread_source ?? null,
    firstTs: records.find((r) => r?.timestamp)?.timestamp ?? null,
  };
}

function realUserText(payload) {
  // role 有第三种取值 developer（承载 <app-context> 系统前言），必须排除
  if (payload?.type !== 'message' || payload.role !== 'user') return null;
  const raw = blocksText(payload.content).trim();
  if (!raw) return null;
  if (isSyntheticPreamble(raw)) {
    // 抢救优先：注入块里夹着的真实请求也是用户说的话。
    // 抢救不到就返回 null，scanForward 会自动顺延到下一条消息。
    return extractUserRequest(raw);
  }
  const stripped = stripPluginMention(raw);
  return stripped || null;
}

export function codexFirstUserText(file, { capBytes = 4 * 1024 * 1024 } = {}) {
  const line = scanForward(file, (l) => {
    if (!l.includes('"role":"user"')) return false; // 廉价预筛，避免逐行 JSON.parse
    try {
      return realUserText(JSON.parse(l).payload) !== null;
    } catch {
      return false;
    }
  }, capBytes);
  if (!line) return null;
  try {
    return realUserText(JSON.parse(line).payload);
  } catch {
    return null;
  }
}

/** 驼峰（app-server 消息里）→ 蛇形（库里），和 agent/codexGoal.js 的 normStatus 一样 */
function normGoalStatus(s) {
  const map = { usageLimited: 'usage_limited', budgetLimited: 'budget_limited' };
  return typeof s === 'string' ? (map[s] ?? s) : null;
}

/**
 * `<codex_internal_context source="user_goal">` 里人对目标做了什么。本机实测两种写法：
 *
 *   User set the goal: "目标原文（可多行）"
 *   User set goal status: "active".
 *
 *   User set goal status: "paused".          ← 只改状态（暂停 / 恢复）
 *
 * 不是这种上下文返回 null。
 */
export function userGoalOf(text) {
  const t = String(text ?? '');
  if (!t.trimStart().startsWith('<codex_internal_context source="user_goal">')) return null;
  const status = /User set goal status:\s*"([A-Za-z_]+)"/.exec(t)?.[1];
  const objective = /User set the goal:\s*"([\s\S]*?)"\s*\n\s*User set goal status/.exec(t)?.[1] ?? null;
  if (!status && !objective) return null;
  return { objective, status: normGoalStatus(status ?? 'active') };
}

export function codexEvents(records) {
  const out = [];
  records.forEach((r, i) => {
    const p = r?.payload;
    if (!p) return;
    const anchor = r.ordinal ?? i;
    const ts = r.timestamp ?? null;

    if (r.type === 'event_msg' && p.type === 'task_complete') {
      out.push(makeEvent({
        id: `${anchor}#turn`, ts, role: 'system', kind: 'turn_end',
        error: p.error?.message ?? undefined,
        text: p.last_agent_message ?? undefined,
      }));
      return;
    }
    /*
      Codex 的目标被**它自己**改了状态（模型标完成、连续没进展标卡住、额度或预算用完）。人的操作
      （设、暂停、恢复）不从这里取——App 改的时候这条和下面那条 user_goal 上下文各写一份，会重复；
      exec 那边干脆不写这条（2026-11-11 实测，agent-protocol §20）
    */
    if (r.type === 'event_msg' && p.type === 'thread_goal_updated') {
      const status = normGoalStatus(p.goal?.status);
      if (status && status !== 'active' && status !== 'paused' && typeof p.goal?.objective === 'string') {
        out.push(makeEvent({
          id: `${anchor}#goal`, ts, role: 'system', kind: 'goal', text: p.goal.objective,
          goal: { met: status === 'complete', reason: null, status },
        }));
      }
      return;
    }
    if (r.type !== 'response_item') return;

    // 人设、暂停、恢复目标：Codex 往会话里写一条给模型看的内部上下文（以 user 角色）
    if (p.type === 'message' && p.role === 'user') {
      const g = userGoalOf(blocksText(p.content));
      if (g) {
        out.push(makeEvent({
          id: `${anchor}#goal`, ts, role: 'system', kind: 'goal', text: g.objective ?? '',
          goal: { met: g.status === 'complete', reason: null, status: g.status },
        }));
        return;
      }
    }

    switch (p.type) {
      case 'reasoning': {
        // 推理正文在 encrypted_content 里不可读；summary 为空就整条丢弃，
        // 否则单个会话会产出上百个空 thinking 事件（实测 173 条）。
        const text = Array.isArray(p.summary)
          ? p.summary.map((s) => s?.text ?? '').join('').trim()
          : '';
        if (text) out.push(makeEvent({ id: `${anchor}#0`, ts, role: 'agent', kind: 'thinking', text }));
        return;
      }
      case 'message': {
        if (p.role !== 'user' && p.role !== 'assistant') return; // developer = 系统前言

        // 用户消息要过一遍 realUserText——**注入的前言也是以 user 角色来的**，
        // 不是只有 developer。实测 Codex 每轮开头都插一条
        // `<environment_context><current_date>…`，直接渲染的话手机上每次
        // 发消息都先看到一大坨 XML，像是自己发出去的。
        // 这层过滤本来只做在标题上，事件流漏了——端到端实测才发现。
        // realUserText 会抢救出注入块里夹着的真实请求（`## My request:` 之后那段），
        // 抢救不到才整条丢弃。
        const text = p.role === 'user'
          ? realUserText(p)
          : blocksText(p.content).trim();
        if (!text) return;
        out.push(makeEvent({
          id: `${anchor}#0`, ts, role: p.role === 'user' ? 'user' : 'agent', kind: 'text', text,
        }));
        return;
      }
      case 'custom_tool_call':
      case 'function_call': {
        out.push(makeEvent({
          id: `${anchor}#0`, ts, role: 'agent', kind: 'tool_call',
          tool: { name: p.name ?? null, id: p.call_id ?? null, input: p.input ?? p.arguments ?? null },
        }));
        return;
      }
      case 'custom_tool_call_output':
      case 'function_call_output': {
        const output = blocksText(p.output) || String(p.output ?? '');
        out.push(makeEvent({
          id: `${anchor}#0`, ts, role: 'system', kind: 'tool_result',
          tool: { name: null, id: p.call_id ?? null, output, ...(FAILED_HEAD.test(output) ? { failed: true } : {}) },
        }));
        return;
      }
      default:
    }
  });
  return out;
}
