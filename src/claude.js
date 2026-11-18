import { makeEvent } from './events.js';

// 非对话内容的记录类型，一律不进事件流。
// 显式列出而非依赖「没有分支匹配」——否则日后若加了通用兜底分支，它们会悄悄漏进来。
// `mode` 形如 {type:'mode', mode:'normal', sessionId}，是交互模式标记（实测 90 条）。
const DISCARD = new Set([
  'attachment', 'atis-latch', 'queue-operation', 'last-prompt', 'custom-title', 'mode',
]);

export function claudeHead(records, ownId) {
  const out = {
    parentId: null, cwd: null, entrypoint: null, version: null, gitBranch: null, firstTs: null,
  };
  let seenId = false;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (out.firstTs === null && r.timestamp) out.firstTs = r.timestamp;
    if (out.cwd === null && r.cwd) {
      out.cwd = r.cwd;
      out.entrypoint = r.entrypoint ?? null;
      out.version = r.version ?? null;
      out.gitBranch = r.gitBranch ?? null;
    }
    if (r.sessionId && !seenId) {
      seenId = true;
      // 分叉会整段复制历史，首条记录带的是祖先的 sessionId
      if (r.sessionId !== ownId) out.parentId = r.sessionId;
    }
  }
  return out;
}

/**
 * 尾部能读到的：最后活动时间，和 CLI 给会话起名的三种记录（各取最后一条）。
 * 三种名字怎么排先后见 titles.js 的 resolveTitle。
 */
export function claudeTail(records) {
  let customTitle = null;
  let agentName = null;
  let aiTitle = null;
  let lastTs = null;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'custom-title' && typeof r.customTitle === 'string') customTitle = r.customTitle;
    else if (r.type === 'agent-name' && typeof r.agentName === 'string') agentName = r.agentName;
    else if (r.type === 'ai-title' && typeof r.aiTitle === 'string') aiTitle = r.aiTitle;
    if (r.timestamp) lastTs = r.timestamp;
  }
  return { customTitle, agentName, aiTitle, lastTs };
}

function userText(message) {
  const c = message?.content;
  let raw;
  if (typeof c === 'string') raw = c;
  else if (Array.isArray(c)) raw = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  else return null;
  /*
    标题取第一句人打的话。斜杠命令那条原来原样进了标题——侧栏里那条
    `<command-message>update-config</command-message>…` 就是这么来的。
    命令换成「/name args」，回执、系统提醒这些注入块不算人打的话，跳过
  */
  const cmd = commandOf(raw);
  if (cmd) return HOUSEKEEPING.has(cmd.name) ? null : commandText(cmd);
  const t = raw.trim();
  if (!t || isInjectedText(t) || interruptOf(t)) return null;
  return t;
}

/**
 * 人打的斜杠命令。CLI 把它写成一条 user 记录，正文是一组标签：
 *
 *   <command-name>/goal</command-name> <command-message>goal</command-message> <command-args>条件</command-args>
 *
 * 2026-11-10 在本机 207 个 transcript 里数过：以 `<command-name>` 开头 91 条（/model、/goal…），
 * 以 `<command-message>` 开头、标签顺序反过来的 11 条（/update-config，VS Code 那边打的）——
 * **全是人打的**。原来它们和系统提醒一起被当成注入块整条丢掉，于是从 Baton 发的 `/goal …`
 * 在对话里凭空消失。现在还原成人打的那句「/goal 条件」。
 */
export function commandOf(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith('<command-name>') && !t.startsWith('<command-message>')) return null;
  const name = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(t)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
  return { name, args };
}

const commandText = ({ name, args }) => `/${name}${args ? ` ${args}` : ''}`;

/**
 * 命令记录不全是人打的。2026-11-10 全量数过本机的命令记录（按 entrypoint 分）：
 *
 *   /model          48  桌面 App / VS Code 里点模型选择器写下的
 *   /reload-skills  12  桌面 App 自己写的
 *   /goal           12  11 条桌面 App、1 条 sdk-cli（Baton 那样经 -p 发的）
 *   /loop 9、/compact 6（都紧跟在压缩摘要后面）、/context 5、其余零星几条
 *
 * 所以分三种：
 *   - entrypoint 是 sdk-cli 的（Baton 发的）  当成人发的消息：「/goal 条件」气泡
 *   - 别的地方记下的                          一行小字（command_output），不做成气泡——
 *                                              owner 当初那张满屏 /compact 的截图就是这个
 *   - 纯内务（reload-skills）连同它的回执      不显示
 */
const HOUSEKEEPING = new Set(['reload-skills', 'reload-plugins']);
const SENT_VIA_CLI = 'sdk-cli';

/**
 * 命令的回执：`<local-command-stdout>…</local-command-stdout>`（也有 stderr）。
 * 同一份回执有两种载体——user 记录（61 条，老写法）和 `type: system, subtype: local_command`
 * （32 条，新写法）。不是回执返回 null；回执是空的返回 ''。
 */
export function commandOutputOf(text) {
  const m = /^\s*<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>\s*$/.exec(String(text ?? ''));
  return m ? m[1].trim() : null;
}

export function claudeFirstUserText(records) {
  for (const r of records) {
    if (r?.type !== 'user' || r.isSidechain === true) continue;
    const t = userText(r.message);
    if (t) return t;
  }
  return null;
}

function tokensFrom(usage) {
  if (!usage) return undefined;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/**
 * 系统注入的包裹标签。正文**以**其中之一开头的 user 记录不是人打的字。
 *
 * `/compact` 那一套（命令块 + 本地命令输出）、后台任务通知、系统提醒——这几种
 * 记录的 `type` 和 `message.role` 都是 `user`，也**没有任何标志位**，唯一认得出
 * 来的就是正文形状。owner 发来的截图里满屏都是它们。
 *
 * 为什么锚在开头而不是「包含」：全量扫过 156 个真会话、40303 条 user 记录，
 * 这些标签出现在非开头位置的 118 次**全是同一个块里的内层标签**
 * （`<command-args>` / `<command-message>`），没有一次出现在人写的散文里；
 * 而夹在真实消息中间的 `<system-reminder>` 是 **0** 条。
 * 用「包含」就会把「为什么 <command-name> 会显示成我发的？」这种消息也吃掉。
 */
const INJECTED_TAGS = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<task-notification>',
  '<system-reminder>',
];

function isInjectedText(text) {
  const t = String(text ?? '').trimStart();
  return INJECTED_TAGS.some((tag) => t.startsWith(tag));
}

/**
 * 中断标记。一轮被人打断时，CLI 往 transcript 里写一条 **type=user** 的记录，
 * 正文是一句方括号英文。不认它的话，三个客户端都把它画成一个用户气泡——
 * 又是那句「我这里明明没发消息但是会显示两条消息」。
 *
 * 2026-09-29 全量扫过（109 个顶层 transcript、54042 条 user 记录）：
 *
 *   57 条，分布在 35 个会话，**只有两种**：
 *     44  `[Request interrupted by user]`
 *     13  `[Request interrupted by user for tool use]`
 *   形状     57 条全是 content 数组里**单独一个** text 块；0 条与人写的字混在同一条里
 *   标志位   isMeta / isVisibleInTranscriptOnly / promptSource 一个都没有，userType 是
 *            external——**和人发的消息毫无区别，只能靠正文认**
 *   位置     0 条是会话里第一条人发的消息，所以标题不受影响
 *
 * 两种各是什么意思，看它前面紧挨着的记录：
 *
 *   for tool use   13/13 紧跟在一条 is_error 的 tool_result 后面，内容都是
 *                  「The user doesn't want to proceed with this tool use. The tool use
 *                  was rejected…」——**拒绝了一次工具调用**
 *   (无后缀)       最常见是紧跟在 agent 正文后面（17 条）——**生成途中被打断**
 *
 * **不丢掉，转成一条 interrupt 事件**：「这一轮停在这里」对看记录的人有信息量——
 * 不说的话，一轮做到一半没有下文，看着像是 agent 自己撂挑子。
 *
 * 话在这里就翻成中文，不交给客户端：「for tool use = 拒绝了工具调用」是**协议知识**，
 * 交出去就得在三个客户端各写一份，迟早说成三种话。
 *
 * **锚在整条正文上**，不用「包含」：同一轮扫描里正好有一条反例——一条人写的、
 * 正文里引用了这句标记的消息（就是要求修这个问题的那条）。用「包含」会把它吃掉。
 * 后缀放开成「方括号里的任意一句」，是为了 CLI 将来多出一种变体时仍认得出来；
 * 它必须**以这句开头、以方括号结尾、整条只有这一句**。
 */
const INTERRUPT = /^\[Request interrupted by user([^\]\n]*)\]$/;

const INTERRUPT_SAYS = {
  '': '这一轮被中途打断',
  ' for tool use': '拒绝了工具调用，这一轮停下',
};

/** 是中断标记就返回给人看的那句话，不是就返回 null。 */
function interruptOf(text) {
  const m = INTERRUPT.exec(String(text ?? '').trim());
  if (!m) return null;
  return INTERRUPT_SAYS[m[1]] ?? '这一轮被打断';
}

export function claudeEvents(records) {
  const out = [];
  // 上一条命令是纯内务、被藏起来了：紧跟着它的回执也藏
  let hideOutput = false;
  records.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    /**
     * `isMeta` 的记录是**系统注入的**，不是人打的字。
     *
     * 它的 role 就是 `user`，内容也是普通文本，所以不看这个标志就会原样渲染成
     * 用户气泡——owner 实测：「我这里明明没发消息但是会显示两条消息」，那两条
     * 正是我读他截图时注入的 `[Image: original 1206x2622, displayed at …]`。
     *
     * 在他这台机器上全量数过：6194 条 user 记录里有 32 条 isMeta，只有三种内容，
     * 没有一种是人写的——
     *
     *   14  技能注入（"Base directory for this skill: …"）
     *   12  读图提示（"[Image: original …]"）
     *    6  续接提示（"Continue from where you left off…"）
     *
     * 放在这里而不是在下面那个 user 分支里跳过：assistant 记录理论上也可能带这个
     * 标志，而「系统注入」这件事和角色无关。
     */
    /**
     * `isVisibleInTranscriptOnly` 的字面意思就是「只在本地那个 transcript 查看器
     * 里显示」——也就是**不属于对话**。`/compact` 产出的压缩摘要就是这一类：
     * 它的 role 是 user，正文是「This session is being continued from a previous
     * conversation…」外加一长篇自动生成的摘要，owner 一个字都没打过。
     *
     * 用它而不是 `isCompactSummary`：后者只覆盖压缩摘要这一种，前者是这一类的
     * 通名。实测两者在 40303 条 user 记录里各 147 条、**完全重合**，从不单独出现，
     * 所以挑通名的那个不会漏，将来多出别的同类也自动包含。
     */
    const anchor = r.uuid ?? String(i);
    const ts = r.timestamp ?? null;
    /*
      /goal 的进度。附件整体是丢掉的（DISCARD），只捞这一种。实测（2026-11-10，claude 2.1.322）
      一个目标的一生：

        { met: false, sentinel: true, condition }   刚设上——那句「Goal set」回执已经说了，不重复
        { met: false, condition, reason }           agent 想停、检查没过，被打回去接着干
        { met: true,  condition, reason }           达成，reason 是判定依据
    */
    if (r.type === 'attachment' && r.attachment?.type === 'goal_status' && r.isSidechain !== true) {
      const g = r.attachment;
      if (g.sentinel === true || typeof g.condition !== 'string') return;
      out.push(makeEvent({
        id: `${anchor}#goal`, ts, role: 'system', kind: 'goal', text: g.condition,
        goal: { met: g.met === true, reason: typeof g.reason === 'string' ? g.reason : null },
      }));
      return;
    }
    // 命令回执的新写法：`type: system, subtype: local_command`，正文就是那串标签
    if (r.type === 'system' && r.subtype === 'local_command' && r.isSidechain !== true) {
      const said = commandOutputOf(typeof r.content === 'string' ? r.content : '');
      if (said !== null && hideOutput) hideOutput = false;
      else if (said) out.push(makeEvent({ id: `${anchor}#0`, ts, role: 'system', kind: 'command_output', text: said }));
      return;
    }
    if (DISCARD.has(r.type)
      || r.isSidechain === true
      || r.isMeta === true
      || r.isVisibleInTranscriptOnly === true) return;
    const tokens = r.type === 'assistant' ? tokensFrom(r.message?.usage) : undefined;

    if (r.type === 'user') {
      const c = r.message?.content;
      // 实测 promptSource 只有两种情形：'sdk'（103 条）与缺失（417 条），没有 'desktop' 这个值。
      // 故 'sdk' 能正面证明「由程序发送」（Baton 走 -p 就是这一类），
      // 但缺失不能反证「在 App 里手打」——不做该推断。
      const origin = r.promptSource === 'sdk' ? 'sdk' : undefined;
      // 一段 user 文本 → 事件。中断标记变成 interrupt，注入块丢掉，其余才是人写的
      const fromText = (text, id) => {
        if (!text?.trim()) return null;
        // 人打的斜杠命令：还原成「/goal 条件」。要在注入块判断之前——它也以标签开头
        const cmd = commandOf(text);
        if (cmd) {
          if (HOUSEKEEPING.has(cmd.name)) {
            hideOutput = true;
            return null;
          }
          hideOutput = false;
          return r.entrypoint === SENT_VIA_CLI
            ? makeEvent({ id, ts, role: 'user', kind: 'text', text: commandText(cmd), origin })
            : makeEvent({ id, ts, role: 'system', kind: 'command_output', text: commandText(cmd) });
        }
        // 命令回执的老写法：一条 user 记录，正文是 <local-command-stdout>
        const said = commandOutputOf(text);
        if (said !== null) {
          if (hideOutput) {
            hideOutput = false;
            return null;
          }
          return said ? makeEvent({ id, ts, role: 'system', kind: 'command_output', text: said }) : null;
        }
        if (isInjectedText(text)) return null;
        const says = interruptOf(text);
        if (says) return makeEvent({ id, ts, role: 'system', kind: 'interrupt', text: says });
        return makeEvent({ id, ts, role: 'user', kind: 'text', text, origin });
      };
      if (typeof c === 'string') {
        const ev = fromText(c, `${anchor}#0`);
        if (ev) out.push(ev);
        return;
      }
      (Array.isArray(c) ? c : []).forEach((b, bi) => {
        if (b?.type === 'text') {
          const ev = fromText(b.text, `${anchor}#${bi}`);
          if (ev) out.push(ev);
        } else if (b?.type === 'tool_result') {
          const output = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null);
          out.push(makeEvent({
            id: `${anchor}#${bi}`, ts, role: 'system', kind: 'tool_result',
            // is_error 是 CLI 自己记下的成败。客户端只认这个，不从输出里猜词——猜词的那一版
            // 标红的十条里将近九条是冤枉的（docs/ops/agent-protocol.md §22）。
            // 没出错就不带这个字段：「没说失败」不等于「说了成功」
            tool: { name: null, id: b.tool_use_id ?? null, output, ...(b.is_error === true ? { failed: true } : {}) },
          }));
        }
      });
      return;
    }

    if (r.type === 'assistant') {
      const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
      blocks.forEach((b, bi) => {
        const id = `${anchor}#${bi}`;
        // 空正文的块不产出事件，否则会渲染成空行（实测占全部事件的 11%）
        if (b?.type === 'thinking') {
          if (String(b.thinking ?? '').trim()) {
            out.push(makeEvent({ id, ts, role: 'agent', kind: 'thinking', text: b.thinking, tokens }));
          }
        } else if (b?.type === 'text') {
          if (String(b.text ?? '').trim()) {
            out.push(makeEvent({ id, ts, role: 'agent', kind: 'text', text: b.text, tokens }));
          }
        } else if (b?.type === 'tool_use') {
          out.push(makeEvent({
            id, ts, role: 'agent', kind: 'tool_call',
            tool: { name: b.name ?? null, id: b.id ?? null, input: b.input ?? null }, tokens,
          }));
        }
      });
    }
  });
  return out;
}
