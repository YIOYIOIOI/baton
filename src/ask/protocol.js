/**
 * 「让 agent 出选择题」的协议常量与整形。
 *
 * 下面每条依据的完整实测记录在 docs/ops/agent-protocol.md §7。
 *
 * ## 为什么要自己造一个工具
 *
 * Claude Code 交互式界面里那个 `AskUserQuestion`（本机 transcript 里 167 次）
 * **在 `-p` 非交互模式下根本不存在**。2026-09-24 实测三次：
 *
 *   1. 裸跑 `claude -p --output-format stream-json --verbose`
 *      → `system/init` 的 tools 表里没有它，模型自己说「这个会话里没有
 *        AskUserQuestion 工具，所以没法弹出选项框」
 *   2. `--tools Read,Write,Bash,AskUserQuestion`
 *      → CLI **静默丢掉**这个名字，实际 tools 是 `Bash,Read,Write`
 *   3. `--allowedTools AskUserQuestion`
 *      → tools 表原封不动，仍然没有它
 *
 * 所以 Baton 自己跑的那一轮永远拿不到它，没有别的口子。
 *
 * ## 为什么不去正文里认选项
 *
 * 试过，量过，否掉了。在本机 17473 条 agent 正文里跑一个保守的检测器
 * （「问句 + 2~6 条加粗项目符号 + 后面没有大段正文」），命中 29 条（0.17%），
 * 逐条看前 12 条：**只有 2 条是真选择题**，其余 10 条是待办清单、注意事项、
 * 差距列表。精确率约 17%——那会在普通项目符号下面挂一排假按钮。
 *
 * ## 走 MCP
 *
 * MCP 工具在 `-p` 下是**可用的**，而且工具调用**真的阻塞这一轮**。实测：
 *
 *   tools 表里出现 `mcp__baton__ask`（`source: "dynamic"`, `status: "connected"`）
 *   MCP server 故意睡 4 秒  → 该轮 duration_ms = 10100
 *   故意睡 75 秒            → 该轮 duration_ms = 81433，**不超时**
 *
 * 权限面也实测过，判据是磁盘副作用不是 agent 的说辞：
 *
 *   默认档位、不加 --allowedTools     → 被拒，7.9 秒快速失败（不挂）
 *   默认档位 + --allowedTools <本工具> → ask 放行；同一轮里的 Write 与 Bash
 *                                       **仍被拒**，canary.txt / shell.txt 都没生成
 *
 * 也就是说白名单只开了这一个口子，而这个口子唯一的能力是「问用户一句话」。
 */

/** 工具全名。claude 给 MCP 工具的命名是 `mcp__<服务名>__<工具名>`。 */
export const ASK_SERVER = 'baton';
export const ASK_TOOL_SHORT = 'ask';
export const ASK_TOOL = `mcp__${ASK_SERVER}__${ASK_TOOL_SHORT}`;

/** MCP 服务器回连守护进程时带的头。值是**这一轮**的一次性令牌。 */
export const ASK_HEADER = 'x-baton-ask';

/**
 * 等人回答的上限。
 *
 * 超时之后 agent 会拿到「没人回答」并能正常收尾（多半是把问题写成正文，
 * 也就是今天的行为），而不是一直挂着等一个不会来的回答。
 * （原先还有一条理由是「比 runProcess 的整轮上限 600 秒短」——那个上限
 * 2026-10-01 已撤掉，见 agent/spawn.js。）
 */
export const ASK_TIMEOUT_MS = 240_000;

/** 超时后交回给 agent 的那句话。要能让它自己决定怎么继续。 */
export const ASK_TIMEOUT_TEXT = '用户没有在限定时间内回答（可能手机不在手边）。'
  + '不要再调用这个工具，改成把问题和选项写在你的回复正文里，然后结束这一轮。';

export const ASK_CANCELLED_TEXT = '这一轮已被用户停止，问题作废。';

const MAX_OPTIONS = 8;
const MAX_LABEL = 120;
const MAX_DESC = 600;
const MAX_QUESTION = 400;

function text(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 把 agent 传来的参数整形成界面能直接渲染的形状，**不合格就退回错误**。
 *
 * 宁可让这一次工具调用失败并把原因告诉 agent（它会改正后重试或改走正文），
 * 也不要把半个问题推到手机上——一个只有问题没有选项的卡片，用户点不了，
 * 而这一轮还在那儿等着。
 */
export function normalizeAsk(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const question = text(o.question, MAX_QUESTION);
  if (!question) return { error: 'question 必须是一句非空的问题文本。' };

  const list = Array.isArray(o.options) ? o.options : [];
  const options = [];
  for (const item of list) {
    // 两种形状都收：裸字符串（模型最省事的写法）与 {label, description}
    const label = typeof item === 'string' ? text(item, MAX_LABEL) : text(item?.label, MAX_LABEL);
    if (!label) continue;
    const description = typeof item === 'string' ? null : text(item?.description, MAX_DESC);
    if (options.some((x) => x.label === label)) continue; // 重复选项点不出区别
    options.push({ label, description });
    if (options.length >= MAX_OPTIONS) break;
  }
  if (options.length < 2) {
    return { error: `options 至少要有 2 个可区分的选项（收到 ${options.length} 个）。` };
  }

  return {
    ask: {
      question,
      options,
      multiSelect: o.multiSelect === true,
      // 给这次提问一句抬头，手机上折行少。没有就用问题本身，渲染层再截断
      header: text(o.header, 40) ?? null,
    },
  };
}

/**
 * 回答交回给 agent 的标准文本格式：`The user answered: "问题"="答案"`，
 * 与 Claude Code 内置提问结果格式一致，便于模型直接理解。
 */
export function formatAnswer({ question, picked = [], free = null }) {
  const parts = [...picked];
  if (free) parts.push(free);
  const answer = parts.join('、') || '（未选择）';
  return `The user answered: "${question}"="${answer}". `
    + 'Read the answer carefully — they may request clarification, changes, '
    + 'or that you not proceed — and follow what they actually say.';
}
