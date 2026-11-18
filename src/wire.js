import { claudeEvents } from './claude.js';
import { codexEvents } from './codex.js';
import { antigravityEvents } from './antigravity.js';

// 事件出网的唯一出口。
//
// 分页与 tail-follow 两条路径都必须走这里。曾经它们各自持有
// `member.agent === 'claude' ? claudeEvents : codexEvents`，于是任何出网前的处理
// 都得在两处各做一遍——做漏一处就是超长载荷直接进隧道。structural 测试断言
// paginate.js / follow.js 不再直接引用那两个函数，新加第三条路径也绕不过去。

// 真实语料实测（60 个会话）：
//   tool.output   最长 347,481 字，15% 超 2500 字   → 必须截
//   tool.input    最长  15,945 字， 8% 超 2500 字   → 应该截
//   text          最长  17,751 字， 5% 超 2500 字   → **不截**
//   thinking      最长   1,984 字， 0% 超 2500 字   → 无需截
//
// text 不截是有意的：它是用户真正要读的回答，截它等于藏答案；而且最长只有
// tool.output 的 1/20，不构成带宽或滚动问题。给它加一条几乎永不触发的上限，
// 只会多出一条从没被执行过的代码路径。
const HEAD = 2000;
const TAIL = 500;

export function truncatePayload(value, { head = HEAD, tail = TAIL } = {}) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (s.length <= head + tail) return { value, truncation: null };
  return {
    value: `${s.slice(0, head)}\n\n……省略 ${s.length - head - tail} 字……\n\n${s.slice(-tail)}`,
    // 首尾都留：失败信息（测试失败行、stream disconnected before completion）
    // 几乎总在尾部，只留头部等于把最该看的那段扔掉。
    truncation: { totalChars: s.length, keptHead: head, keptTail: tail },
  };
}

function truncateEvent(ev) {
  if (!ev.tool) return ev;
  const out = ev.tool.output == null ? null : truncatePayload(ev.tool.output);
  const inp = ev.tool.input == null ? null : truncatePayload(ev.tool.input);
  if (!out?.truncation && !inp?.truncation) return ev;
  return {
    ...ev,
    tool: {
      ...ev.tool,
      ...(out ? { output: out.value } : {}),
      ...(inp ? { input: inp.value } : {}),
    },
    truncation: {
      ...(out?.truncation ? { output: out.truncation } : {}),
      ...(inp?.truncation ? { input: inp.truncation } : {}),
    },
  };
}

function eventsOf(agent) {
  if (agent === 'claude') return claudeEvents;
  if (agent === 'antigravity') return antigravityEvents;
  return codexEvents;
}

// records → 出网事件。offset 是该记录在 transcript 里的字节偏移，
// 客户端拿它去 /events/:id/full 取全文——不带偏移就得全文件扫描找 anchor，
// 而 transcript 实测能到 175 MB。
export function eventsFor(member, records, { offset = null } = {}) {
  const toEvents = eventsOf(member.agent);
  return toEvents(records).map((ev) => {
    const wire = truncateEvent(ev);
    return offset === null ? wire : { ...wire, offset };
  });
}

// 取全文的唯一豁免路径：它就是为了拿未截断的载荷而存在的。
// 单独命名是为了让「绕过截断」这件事在代码里可被搜索、可被审查。
export function eventsForFull(member, records) {
  const toEvents = eventsOf(member.agent);
  return toEvents(records);
}
