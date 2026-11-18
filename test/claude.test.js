import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeHead, claudeTail, claudeFirstUserText, claudeEvents } from '../src/claude.js';

const OWN = 'aaaaaaaa-0000-0000-0000-000000000001';
const PARENT = 'bbbbbbbb-0000-0000-0000-000000000002';

const base = (over = {}) => ({
  cwd: 'C:\\proj', entrypoint: 'claude-desktop-3p', version: '2.1.246',
  gitBranch: 'HEAD', isSidechain: false, ...over,
});

test('claudeHead 自根会话的 parentId 为 null', () => {
  const h = claudeHead([
    base({ type: 'user', sessionId: OWN, uuid: 'u1', timestamp: '2026-09-08T06:23:02Z', message: { role: 'user', content: 'hi' } }),
  ], OWN);
  assert.equal(h.parentId, null);
  assert.equal(h.cwd, 'C:\\proj');
  assert.equal(h.version, '2.1.246');
  assert.equal(h.firstTs, '2026-09-08T06:23:02Z');
});

test('claudeHead 首记录 sessionId 不等于文件名时给出父指针', () => {
  const h = claudeHead([
    base({ type: 'user', sessionId: PARENT, uuid: 'u1', timestamp: '2026-09-08T03:03:55Z', message: { role: 'user', content: 'hi' } }),
  ], OWN);
  assert.equal(h.parentId, PARENT, '这是分叉，首记录带的是祖先 id');
});

test('claudeTail 取最后一条 custom-title', () => {
  const t = claudeTail([
    { type: 'custom-title', customTitle: '旧标题', sessionId: PARENT },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-09-08T07:00:00Z', message: { role: 'assistant', content: [] } },
    { type: 'custom-title', customTitle: '新标题 (fork)', sessionId: OWN },
  ]);
  assert.equal(t.customTitle, '新标题 (fork)');
  assert.equal(t.lastTs, '2026-09-08T07:00:00Z');
});

test('claudeTail 无 custom-title 时返回 null', () => {
  assert.equal(claudeTail([{ type: 'user', message: { role: 'user', content: 'x' } }]).customTitle, null);
});

/*
  CLI 给会话起名的另外两种记录。2026-10-01 全量扫 117 个 transcript：
    agent-name  43 个文件有，末条距文件尾最远 31 KB
    ai-title    15 个文件有，末条距文件尾最远 30 KB
  都在尾部 64 KB 窗口里，不用另读文件头。
*/
test('claudeTail 也取最后一条 agent-name 与 ai-title', () => {
  const t = claudeTail([
    { type: 'ai-title', aiTitle: 'proof review', sessionId: OWN },
    { type: 'agent-name', agentName: 'reviewer-agent', sessionId: OWN },
    { type: 'ai-title', aiTitle: 'architecture review', sessionId: OWN },
  ]);
  assert.equal(t.aiTitle, 'architecture review');
  assert.equal(t.agentName, 'reviewer-agent');
  assert.equal(t.customTitle, null);
});

test('claudeFirstUserText 跳过 tool_result 型 user 记录', () => {
  const text = claudeFirstUserText([
    base({ type: 'user', uuid: 'u0', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    base({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Check the build warnings' } }),
  ]);
  assert.equal(text, 'Check the build warnings');
});

test('claudeEvents 归一化 thinking / text / tool_use / tool_result', () => {
  const evs = claudeEvents([
    base({ type: 'user', uuid: 'u1', timestamp: '2026-09-08T06:23:02Z', promptSource: 'sdk', message: { role: 'user', content: '开始' } }),
    base({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-08T06:23:10Z', message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先看目录' },
        { type: 'text', text: '我来看一下' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    } }),
    base({ type: 'user', uuid: 'u2', timestamp: '2026-09-08T06:23:12Z', message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }],
    } }),
  ]);
  assert.deepEqual(evs.map((e) => e.kind), ['text', 'thinking', 'text', 'tool_call', 'tool_result']);
  assert.equal(evs[0].role, 'user');
  assert.equal(evs[0].origin, 'sdk', 'promptSource=sdk 必须透出为 origin，标记「由程序发送」');
  assert.equal(evs[3].tool.name, 'Bash');
  assert.equal(evs[4].tool.output, 'a.txt');
  assert.ok(evs.every((e) => typeof e.id === 'string' && e.id.length > 0));
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length, '事件 id 必须唯一');
});

test('claudeEvents 丢弃噪声记录类型与 sidechain', () => {
  const evs = claudeEvents([
    { type: 'attachment', attachment: {}, uuid: 'x1' },
    { type: 'atis-latch', atis: {}, sessionId: OWN },
    { type: 'queue-operation', operation: 'add', sessionId: OWN },
    { type: 'last-prompt', lastPrompt: 'x', sessionId: OWN },
    { type: 'custom-title', customTitle: 't', sessionId: OWN },
    { type: 'mode', mode: 'normal', sessionId: OWN },
    base({ type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子 agent' }] } }),
  ]);
  assert.deepEqual(evs, []);
});

/**
 * 系统注入的记录不是用户消息。
 *
 * 这条是被真机上的 bug 逼出来的：owner 报「我这里明明没发消息但是会显示两条
 * 消息」，那两条正是 Claude Code 在读图片时注入的 `[Image: original …]`。
 * 它的 `type` 和 `message.role` 都是 `user`、内容是普通字符串，**唯一能认出来的
 * 标志就是 `isMeta`**。
 *
 * 在 owner 那台机器上全量数过：6194 条 user 记录里 32 条 isMeta，只有三种内容
 * （技能注入 14、读图提示 12、续接提示 6），没有一种是人写的。
 */
test('isMeta 的记录是系统注入的，不算用户消息', () => {
  const evs = claudeEvents([
    base({ type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: '[Image: original 1206x2622, displayed at 920x2000.]' } }),
    base({ type: 'user', uuid: 'm2', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: …' }] } }),
    base({ type: 'user', uuid: 'u1', message: { role: 'user', content: '这条才是人打的' } }),
  ]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].text, '这条才是人打的');
});

/**
 * `/compact` 之后那一整套内部管道，不能当成用户说的话。
 *
 * owner 发来两张截图：一屏里出现了「Continue the conversation from where it left
 * off…」的续接提示、`<command-name>/compact</command-name>`、
 * `<local-command-stdout>Compacted</local-command-stdout>`，另一屏里是压缩摘要正文
 * 「9. **Optional Next Step:** …」。这些他一个字都没打过。
 *
 * 在他这台机器上全量数过：156 个真会话、40303 条 user 记录里——
 *
 *   147  isCompactSummary，且与 isVisibleInTranscriptOnly **完全重合**（两者从不单独出现）
 *   282  正文以 <task-notification> 开头
 *    59  正文是 <command-name>/… 那一整块（50 条以它开头，9 条以 <command-message> 开头）
 *    28  正文是 <local-command-stdout>…</local-command-stdout>
 *     4  正文以 <system-reminder> 开头
 *
 * 判据分两层，各有各的理由：
 *
 *   - `isVisibleInTranscriptOnly` —— 它的字面意思就是「只在本地那个 transcript
 *     查看器里显示」，也就是**不属于对话**。用它而不是 isCompactSummary：后者只
 *     覆盖压缩摘要这一种，前者是这一类的通名。
 *   - 正文**以**已知系统包裹标签开头 —— 这几种记录没有任何标志位，只能看内容。
 *     锚在开头而不是「包含」：全量扫过，这些标签出现在非开头位置的 118 次**全是
 *     同一个块里的内层标签**（command-args / command-message），没有一次是人写的
 *     散文里提到它们；而夹在真实消息中间的 <system-reminder> 是 **0** 条。
 *     所以锚定开头既抓得全，又不会误伤「正好在讨论这个标签」的消息。
 */
/*
 * 2026-11-10 改了一半：命令块和它的回执不再整条丢掉——从 Baton 发的 `/goal 条件` 会凭空消失。
 * 但这里这些（entrypoint 是桌面 App）仍然**不是用户气泡**：它们变成一行小字的 command_output，
 * 那张满屏 /compact 的截图要的就是「别当成我说的话」。Baton 发的命令见下一条测试。
 */
test('压缩摘要与斜杠命令的内部管道，不算用户消息', () => {
  const evs = claudeEvents([
    base({
      type: 'user', uuid: 'c1', isCompactSummary: true, isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
    }),
    base({
      type: 'user', uuid: 'c2',
      // 真实形状：三行一块，后两行带缩进（见 test 抬头那段全量统计）
      message: {
        role: 'user',
        content: [
          '<command-name>/compact</command-name>',
          '            <command-message>compact</command-message>',
          '            <command-args></command-args>',
        ].join('\n'),
      },
    }),
    base({
      type: 'user', uuid: 'c3',
      message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' },
    }),
    base({
      type: 'user', uuid: 'c4',
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification>后台任务完成</task-notification>' }] },
    }),
    base({
      type: 'user', uuid: 'c5',
      message: { role: 'user', content: '<system-reminder>别忘了…</system-reminder>' },
    }),
    base({ type: 'user', uuid: 'u1', message: { role: 'user', content: '这条才是人打的' } }),
  ]);
  const said = evs.filter((e) => e.role === 'user');
  assert.equal(said.length, 1, '六条里只有一条是人说的');
  assert.equal(said[0].text, '这条才是人打的');
  // 桌面 App 记下的 /compact 和它的回执：一行小字，不是气泡；摘要、任务通知、系统提醒照旧丢掉
  assert.deepEqual(evs.filter((e) => e.role !== 'user').map((e) => [e.kind, e.text]), [
    ['command_output', '/compact'],
    ['command_output', 'Compacted'],
  ]);
});

/*
 * 2026-11-10，claude 2.1.322 实测：经 stdin 发给 `claude -p` 的 `/goal 条件`，transcript 里是
 * 一条 entrypoint=sdk-cli 的命令块，后面跟 system/local_command 回执和 goal_status 附件。
 */
const GOAL_RECORDS = [
  {
    type: 'user', uuid: 'g1', entrypoint: 'sdk-cli', timestamp: '2026-11-10T15:07:33.000Z',
    message: { role: 'user', content: '<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>the file ok.txt exists</command-args>' },
  },
  {
    type: 'system', subtype: 'local_command', uuid: 'g2', entrypoint: 'sdk-cli',
    content: '<local-command-stdout>Goal set: the file ok.txt exists</local-command-stdout>',
  },
  { type: 'user', uuid: 'g3', isMeta: true, message: { role: 'user', content: 'A session-scoped Stop hook is now active…' } },
  { type: 'attachment', uuid: 'g4', attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'the file ok.txt exists' } },
  { type: 'attachment', uuid: 'g5', attachment: { type: 'goal_status', met: false, condition: 'the file ok.txt exists', reason: 'not yet' } },
  { type: 'assistant', uuid: 'g6', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  { type: 'attachment', uuid: 'g7', attachment: { type: 'goal_status', met: true, condition: 'the file ok.txt exists', reason: 'ok.txt contains ok' } },
];

test('Baton 发的 /goal：还原成人打的那句，回执一行，进度两行（刚设上那条不重复）', () => {
  const evs = claudeEvents(GOAL_RECORDS);
  assert.deepEqual(evs.map((e) => [e.kind, e.role, e.text]), [
    ['text', 'user', '/goal the file ok.txt exists'],
    ['command_output', 'system', 'Goal set: the file ok.txt exists'],
    ['goal', 'system', 'the file ok.txt exists'],
    ['text', 'agent', 'done'],
    ['goal', 'system', 'the file ok.txt exists'],
  ]);
  assert.deepEqual(evs[2].goal, { met: false, reason: 'not yet' });
  assert.deepEqual(evs[4].goal, { met: true, reason: 'ok.txt contains ok' });
});

test('桌面 App 自己写的 /reload-skills 连同回执都不显示；标题不取命令的原始标签', () => {
  const evs = claudeEvents([
    base({ type: 'user', uuid: 'r1', message: { role: 'user', content: '<command-message>reload-skills</command-message>\n<command-name>/reload-skills</command-name>' } }),
    base({ type: 'user', uuid: 'r2', message: { role: 'user', content: '<local-command-stdout>Reloaded 70 skills</local-command-stdout>' } }),
    base({ type: 'user', uuid: 'u1', message: { role: 'user', content: '正文' } }),
  ]);
  assert.deepEqual(evs.map((e) => e.text), ['正文']);
  // 原来侧栏的标题就是 `<command-message>update-config</command-message>…` 原样
  assert.equal(claudeFirstUserText([
    base({ type: 'user', message: { role: 'user', content: '<command-message>update-config</command-message>\n<command-name>/update-config</command-name>' } }),
  ]), '/update-config');
  assert.equal(claudeFirstUserText([
    base({ type: 'user', message: { role: 'user', content: '<command-message>reload-skills</command-message>\n<command-name>/reload-skills</command-name>' } }),
    base({ type: 'user', message: { role: 'user', content: '真正的第一句' } }),
  ]), '真正的第一句');
});

test('只是「提到」那些标签的真实消息要留下——锚在开头，不是包含', () => {
  // 这条消息本身就是在讨论这个 bug。按「包含」过滤会把它吃掉。
  const evs = claudeEvents([
    base({ type: 'user', uuid: 'u1', message: { role: 'user', content: '为什么 <command-name> 这种东西会显示成我发的？' } }),
    base({ type: 'user', uuid: 'u2', message: { role: 'user', content: '日志里有 <local-command-stdout>，帮我看看' } }),
  ]);
  assert.equal(evs.length, 2, '真实消息里提到标签名不该被当成管道');
});

/**
 * 中断标记。形状取自 2026-09-29 的全量扫描（src/claude.js 里 interruptOf 那段）：
 * 57 条全是 content 数组里单独一个 text 块，没有任何标志位——只能靠正文认。
 */
const interruptRec = (uuid, text) => base({
  type: 'user', uuid, userType: 'external',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

test('中断标记不是人发的消息：两种变体都变成一条 system 的 interrupt 事件', () => {
  const evs = claudeEvents([
    interruptRec('i1', '[Request interrupted by user]'),
    interruptRec('i2', '[Request interrupted by user for tool use]'),
  ]);
  assert.equal(evs.length, 2);
  assert.ok(evs.every((e) => e.kind === 'interrupt' && e.role === 'system'),
    '不能是 user——那就是又一个「我明明没发消息」');
  assert.equal(evs[0].text, '这一轮被中途打断');
  assert.equal(evs[1].text, '拒绝了工具调用，这一轮停下');
  assert.equal(evs[0].id, 'i1#0', 'id 规则和别的块一样，取全文 / 续传都靠它');
});

test('中断标记是字符串正文时同样认得出，前后空白不影响', () => {
  const evs = claudeEvents([
    base({ type: 'user', uuid: 's1', message: { role: 'user', content: '  [Request interrupted by user]\n' } }),
  ]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'interrupt');
});

test('将来多出一种变体也认得出——但要整条就是这一句', () => {
  const evs = claudeEvents([interruptRec('v1', '[Request interrupted by user for plan mode]')]);
  assert.equal(evs[0].kind, 'interrupt');
  assert.equal(evs[0].text, '这一轮被打断', '认不出具体是哪种就说最朴素的那句，不编');
});

test('人写的、只是提到那句标记的消息要留下——锚在整条正文上，不是包含', () => {
  // 这不是编的：全量扫描里正好有一条这样的真消息——要求修这个问题的那条。
  const evs = claudeEvents([
    interruptRec('h1', '为什么显示 [Request interrupted by user]？'),
    interruptRec('h2', '[Request interrupted by user] 这句是什么意思'),
    interruptRec('h3', '[Request interrupted by user]\n\n然后我接着说一句'),
  ]);
  assert.equal(evs.length, 3);
  assert.ok(evs.every((e) => e.kind === 'text' && e.role === 'user'), '三条都是人写的');
});

test('同一条记录里标记和人写的字各算各的', () => {
  // 实测 0 条这样混着的；但真出现了也不能把人写的那半吃掉
  const evs = claudeEvents([
    base({
      type: 'user', uuid: 'm1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Request interrupted by user]' },
          { type: 'text', text: '换个方向，先查日志' },
        ],
      },
    }),
  ]);
  assert.deepEqual(evs.map((e) => [e.kind, e.role]), [['interrupt', 'system'], ['text', 'user']]);
});

test('空正文的 text / thinking 块不产出事件（否则渲染成空行）', () => {
  const evs = claudeEvents([
    base({ type: 'assistant', uuid: 'a1', message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '' },
        { type: 'thinking', thinking: '   ' },
        { type: 'text', text: '有内容' },
      ],
    } }),
  ]);
  assert.equal(evs.length, 1, '实测空正文事件占全部事件的 11%，必须在源头挡掉');
  assert.equal(evs[0].text, '有内容');
});

test('claudeEvents 从 usage 提取 token 计数', () => {
  const evs = claudeEvents([
    base({ type: 'assistant', uuid: 'a1', message: {
      role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 3955, cache_read_input_tokens: 54095, output_tokens: 10772,
               output_tokens_details: { thinking_tokens: 7928 } },
    } }),
  ]);
  assert.equal(evs[0].tokens.input, 3955);
  assert.equal(evs[0].tokens.output, 10772);
  assert.equal(evs[0].tokens.cacheRead, 54095);
  assert.equal(evs[0].tokens.thinking, 7928);
});

test('tool_result 带 is_error 的透出为 tool.failed——客户端只认这个，不再从输出里猜词', () => {
  // 2026-10-10 全量（126 个 transcript、70745 条工具结果）：is_error 为 true 的 1685 条。
  // 手机端原来在输出末尾 600 字里找 error|failed|fatal|Traceback|not found：标红的 5758 条里
  // 4980 条其实没出错（「errors: none」「0 failed」、网址里的 /error），真出错的又漏了 907 条
  // （「File does not exist.」这种一个关键词都不带）
  const evs = claudeEvents([
    base({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pytest' } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'x' } },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'cat log' } },
      { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'ls' } },
    ] } }),
    base({ type: 'user', uuid: 'u1', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1\n1 failed', is_error: true },
      { type: 'tool_result', tool_use_id: 't2', content: 'File does not exist.', is_error: true },
      { type: 'tool_result', tool_use_id: 't3', content: 'errors: none\n0 failed', is_error: false },
      { type: 'tool_result', tool_use_id: 't4', content: 'fatal.log' },
    ] } }),
  ]);
  const results = evs.filter((e) => e.kind === 'tool_result');
  assert.deepEqual(results.map((e) => e.tool.failed === true), [true, true, false, false]);
  // 「没说失败」不等于「说了成功」：没有出错标记就不带这个字段，不写 failed: false
  assert.ok(!('failed' in results[2].tool) && !('failed' in results[3].tool));
});
