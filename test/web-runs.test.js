// 网页端会话里「一段活」的折叠：怎么分段、折叠行那句话怎么数。
//
// 和 web-tools.test.js 同一条路子：`web/src/runs.ts` 是纯函数、不碰 DOM、不 import css，
// Node 24 直接 import .ts 就能跑。
//
// 验证规则：
//   1. 「共 N 次工具调用」不重复统计命令次数（1 次 Bash + 3 次其他 = 跑了 1 条命令、用了 3 次其他工具）
//   2. 「改了 N 个文件」按去重文件数计
//   3. 命令识别 Bash、PowerShell、Codex shell_command
//   4. Codex 的 `run`（web search/open）归为上网，不误算命令
//   5. 思考并入同一段活动，不再把连续工具调用切碎

import test from 'node:test';
import assert from 'node:assert/strict';

import { beadOf, doingOf, group, kindOf, peekFor, summarize } from '../web/src/runs.ts';

/* ── 造事件 ───────────────────────────────────────────────────────────────── */

let seq = 0;
const base = (over) => ({ id: `e${(seq += 1)}`, offset: seq, ts: '2026-10-10T00:00:00Z', ...over });

const said = (text) => base({ kind: 'text', role: 'user', text });
const wrote = (text) => base({ kind: 'text', role: 'agent', text });
const thought = (text = '先看看') => base({ kind: 'thinking', role: 'agent', text });
function call(name, input) {
  const id = `t${seq + 1}`;
  return base({ kind: 'tool_call', role: 'agent', tool: { id, name, input } });
}
const result = (c, output = 'ok') => base({ kind: 'tool_result', role: 'system', tool: { id: c.tool.id, name: null, output } });

/** 一串调用，各配上结果。返回 [call, result, call, result, …] */
function calls(...specs) {
  return specs.flatMap(([name, input]) => {
    const c = call(name, input);
    return [c, result(c)];
  });
}

/** group 之后，每个 run 里的工具调用。给 summarize 用 */
const toolsOf = (run) => run.steps.filter((s) => s.t === 'tool').map((s) => s.tool);
const runs = (items) => items.filter((it) => it.t === 'run');
const say = (...specs) => summarize(toolsOf(runs(group(calls(...specs)))[0]));

const bash = (command) => ['Bash', { command }];
const edit = (file_path) => ['Edit', { file_path, old_string: 'a', new_string: 'b' }];
const read = (file_path) => ['Read', { file_path }];
const mcp = (tool) => [`mcp__ccd_session_mgmt__${tool}`, { query: 'x' }];

/* ── 分段 ─────────────────────────────────────────────────────────────────── */

test('思考不切断一段活：两段正文之间只有一行', () => {
  const evs = [
    said('改一下'),
    ...calls(bash('pytest'), bash('pytest -k a')),
    thought(),
    ...calls(edit('C:\\x\\daily.py')),
    thought(),
    ...calls(bash('pytest')),
    wrote('两条都红。'),
  ];
  const items = group(evs);
  assert.deepEqual(items.map((it) => it.t), ['ev', 'run', 'ev'], '中间那段活应该折成一行');
  const run = items[1];
  // 思考按先后留在这段活里，展开时排在时间线上
  assert.deepEqual(run.steps.map((s) => s.t), ['tool', 'tool', 'think', 'tool', 'think', 'tool']);
});

test('只有思考、没有工具的那段不折，仍是一条条思考', () => {
  const items = group([said('在吗'), thought('想一下'), wrote('在。')]);
  assert.deepEqual(items.map((it) => it.t === 'ev' && it.ev.kind), ['text', 'thinking', 'text']);
});

test('正常结束的 turn_end 不占行，也不切断；出错的才说话', () => {
  const ok = base({ kind: 'turn_end', role: 'system' });
  const bad = base({ kind: 'turn_end', role: 'system', error: 'Selected model is at capacity' });
  const a = group([...calls(bash('a')), ok, ...calls(bash('b'))]);
  assert.equal(runs(a).length, 1, '正常结束不该把两边切成两段');
  assert.equal(a.length, 1);
  const b = group([...calls(bash('a')), bad, ...calls(bash('b'))]);
  assert.deepEqual(b.map((it) => it.t), ['run', 'ev', 'run']);
});

test('中断标记切断一段活', () => {
  const stop = base({ kind: 'interrupt', role: 'system', text: '这一轮被中途打断' });
  assert.deepEqual(group([...calls(bash('a')), stop, ...calls(bash('b'))]).map((it) => it.t), ['run', 'ev', 'run']);
});

test('配不上对的结果自己一行，不吞掉', () => {
  const orphan = base({ kind: 'tool_result', role: 'system', tool: { id: 'nope', name: null, output: 'x' } });
  const items = group([orphan, ...calls(bash('a'))]);
  assert.deepEqual(items.map((it) => it.t), ['ev', 'run']);
});

test('结果按 tool.id 配回自己的调用，并行调用也不串', () => {
  const a = call('Bash', { command: 'a' });
  const b = call('Read', { file_path: 'x' });
  const items = group([a, b, result(b, 'B'), result(a, 'A')]);
  const tools = toolsOf(runs(items)[0]);
  assert.equal(tools[0].result.tool.output, 'A');
  assert.equal(tools[1].result.tool.output, 'B');
});

/* ── 折叠行那句话 ─────────────────────────────────────────────────────────── */

test('「其他」只数剩下的，不把命令再算一遍（截图那一段：1 次 Bash + 3 次 MCP）', () => {
  assert.equal(
    say(mcp('search_session_transcripts'), bash('git remote -v'), mcp('search_session_transcripts'), mcp('search_session_transcripts')),
    '跑了 1 条命令、用了 3 次其他工具',
  );
});

test('改文件按文件数：同一个文件改两次是「改了 1 个文件」', () => {
  assert.equal(
    say(edit('C:\\workspace\\proj\\script.py'), edit('C:\\workspace\\proj\\script.py'), bash('a'), bash('b'), bash('c')),
    '改了 1 个文件、跑了 3 条命令',
  );
});

test('路径的大小写和斜杠方向不同也是同一个文件', () => {
  assert.equal(say(edit('C:\\X\\a.py'), edit('c:/x/a.py')), '改了 1 个文件');
});

test('读文件按文件数，搜索按次数', () => {
  assert.equal(
    say(read('/r/a.ts'), read('/r/a.ts'), read('/r/b.ts'), ['Grep', { pattern: 'TODO' }], ['Glob', { pattern: '**/*.ts' }]),
    '读了 2 个文件、搜了 2 次',
  );
});

test('Windows 上 Claude 的 PowerShell 算命令', () => {
  assert.equal(say(['PowerShell', { command: 'Get-Process' }], bash('ls')), '跑了 2 条命令');
});

test('一句话里的先后固定：读 → 搜 → 改 → 跑 → 上网 → 子 agent → 问 → 其他', () => {
  assert.equal(
    say(
      ['mcp__chrome-devtools__take_screenshot', {}],
      ['AskUserQuestion', { questions: [{ question: 'a?' }, { question: 'b?' }] }],
      ['Agent', { description: '复查', prompt: '…' }],
      ['WebSearch', { query: 'x' }],
      bash('npm test'),
      ['Write', { file_path: '/r/new.ts', content: 'x' }],
      ['Grep', { pattern: 'x' }],
      read('/r/a.ts'),
    ),
    '读了 1 个文件、搜了 1 次、改了 1 个文件、跑了 1 条命令、上网查了 1 次、派了 1 个子 agent、问了你 2 个问题、用了 1 次其他工具',
  );
});

test('只有其他工具时不说「其他」', () => {
  assert.equal(say(mcp('list_events'), mcp('list_sessions')), '用了 2 次工具');
});

test('工具名缺失也算一次，不从计数里消失', () => {
  // 旧版先把空名字过滤掉再数，于是珠子比字多
  assert.equal(say([null, { x: 1 }], bash('a')), '跑了 1 条命令、用了 1 次其他工具');
});

test('Write 的输入被截断成半截 JSON 时，照样认得出是哪个文件', () => {
  // src/wire.js 截断时做的是 JSON.stringify 再切片，回到客户端就是一段破 JSON 字符串
  const cut = '{"file_path":"C:\\\\x\\\\big.md","content":"很长很长';
  assert.equal(say(['Write', cut], ['Write', { file_path: 'C:\\x\\big.md', content: '' }]), '改了 1 个文件');
});

/* ── Codex ────────────────────────────────────────────────────────────────── */

test('Codex：shell_command 是命令，run 是上网', () => {
  assert.equal(
    say(
      ['shell_command', '{"command":"Get-ChildItem","workdir":"C:\\\\x"}'],
      ['run', '{"search_query":[{"q":"codex tui"}],"response_length":"short"}'],
      ['run', '{"open":[{"ref_id":"https://example.com"}]}'],
    ),
    '跑了 1 条命令、上网查了 2 次',
  );
});

test('Codex：apply_patch 按补丁里的文件数', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.rs',
    '@@', '-x', '+y',
    '*** Add File: src/b.rs',
    '+fn main() {}',
    '*** Update File: src/a.rs',
    '*** End Patch',
  ].join('\n');
  assert.equal(say(['apply_patch', patch]), '改了 2 个文件');
});

test('Codex：exec 是一段 JS，按它里面调的工具分', () => {
  const cmd = 'const r = await tools.exec_command({cmd:"Get-Content -Raw \'C:\\\\x\\\\a.md\'",workdir:"C:\\\\x"}); text(r)';
  const web = 'const r = await tools.web__run({search_query:[{q:"x"}]}); text(r)';
  // 补丁写在 JS 字符串里，换行是字面量的 \n
  const patch = 'const patch = "*** Begin Patch\\n*** Add File: work/inv.mjs\\n+import fs from \\"node:fs\\";\\n*** End Patch"; await tools.apply_patch(patch)';
  const look = 'text(ALL_TOOLS.filter(x => /shell/.test(x.name)).map(x => x.name));';
  assert.equal(say(['exec', cmd], ['exec', web], ['exec', look]), '跑了 1 条命令、上网查了 1 次、用了 1 次其他工具');
  assert.equal(say(['exec', patch]), '改了 1 个文件');
});

test('Codex：老版本的 exec 是一条裸命令，照旧算命令', () => {
  // tools.ts 的用例里留着那时的形状：shapeInput('exec', 'Get-Process -Name claude')
  assert.equal(say(['exec', 'Get-Process -Name claude']), '跑了 1 条命令');
});

test('Codex：spawn_agent 是派子 agent，wait_agent 之类的调度不算「派」', () => {
  assert.equal(
    say(['spawn_agent', '{"task_name":"audit"}'], ['wait_agent', '{}'], ['send_message', '{}']),
    '派了 1 个子 agent、用了 2 次其他工具',
  );
});

/* ── 珠子：和那句话是同一套分类 ───────────────────────────────────────────── */

test('珠子的形状和那句话用同一套分类：命令画三角、读和搜画空心圈、改画菱形', () => {
  const specs = [
    bash('a'), ['PowerShell', { command: 'b' }], ['shell_command', '{"command":"c"}'],
    read('/a'), ['Grep', { pattern: 'x' }], edit('/a'), ['apply_patch', '*** Begin Patch\n*** Add File: z\n'],
    ['run', '{"search_query":[]}'], ['AskUserQuestion', { questions: [] }], mcp('x'), [null, {}],
  ];
  const shapes = specs.map(([n, i]) => beadOf(kindOf(n, i)));
  assert.deepEqual(shapes, [
    'shell', 'shell', 'shell',
    'read', 'read', 'edit', 'edit',
    'other', 'ask', 'other', 'other',
  ]);
});

/* ── 跑着的时候，状态栏说它在干什么 ───────────────────────────────────────── */

test('状态栏：最近一次调用还没结果，就说那一步，用人话', () => {
  // 旧版是 `Bash({"command":"cd /c/workspace/proj &` 这样的半截 JSON
  assert.equal(doingOf([call('Bash', { command: 'cd /c/workspace/proj && python script.py' })]), '跑 cd /c/workspace/proj && python script.py');
  assert.equal(doingOf([call('Read', { file_path: 'C:\\shop\\src\\coupon.ts' })]), '读 coupon.ts');
  assert.equal(doingOf([call('Edit', { file_path: '/shop/src/coupon.ts' })]), '改 coupon.ts');
  assert.equal(doingOf([call('Grep', { pattern: 'expired' })]), '搜 expired');
  assert.equal(doingOf([call('WebSearch', { query: 'codex tui exec cell' })]), '上网查 codex tui exec cell');
  assert.equal(doingOf([call('Agent', { description: '独立复查', prompt: '…' })]), '派子 agent：独立复查');
  assert.equal(doingOf([call('mcp__chrome-devtools__take_screenshot', {})]), '用 chrome-devtools · take_screenshot');
});

test('状态栏：Codex 的 exec 格子说出里面那条命令', () => {
  const code = 'const r = await tools.exec_command({cmd:"npm test -- coupon",workdir:"C:\\\\x"}); text(r)';
  assert.equal(doingOf([call('exec', code)]), '跑 npm test -- coupon');
  assert.equal(doingOf([call('shell_command', '{"command":"Get-ChildItem src"}')]), '跑 Get-ChildItem src');
});

test('状态栏：两步之间说它在想', () => {
  const c = call('Bash', { command: 'a' });
  assert.equal(doingOf([c, result(c)]), '在想下一步');
  assert.equal(doingOf([c, result(c), thought()]), '在思考');
  assert.equal(doingOf([said('改一下')]), '刚开始');
  assert.equal(doingOf([said('改一下'), wrote('好的，先看看。')]), '在想下一步');
  // 正常的 turn_end 不算一步
  assert.equal(doingOf([c, base({ kind: 'turn_end', role: 'system' })]), '跑 a');
  assert.equal(doingOf([]), null);
});

test('状态栏：并行调用时说的是还没回来的那条，不是最后发出去的那条', () => {
  const a = call('Bash', { command: 'npm test' });
  const b = call('Read', { file_path: '/r/a.ts' });
  assert.equal(doingOf([a, b, result(b)]), '跑 npm test');
});

test('状态栏：很长的命令被截断成半截 JSON，照样说出那条命令', () => {
  const cut = '{"command":"cd /c/x && python daily.py --date 2026-10-09\\n……省略 900 字……';
  assert.equal(doingOf([call('Bash', cut)]), '跑 cd /c/x && python daily.py --date 2026-10-09 ……省略 900 字……');
});

/* ── 单条调用那一行 ───────────────────────────────────────────────────────── */

// tools.ts 的 peekOf 管得了结构化的输入；字符串形状的三种它认不出，原样取第一行：
// 截断过的半截 JSON、apply_patch 的补丁原文、Codex 的 exec 那段 JS。
// 例如 Write {"file_path":"C:\\workspace\\…

test('单条那一行：截断成半截 JSON 的 Write 说是哪个文件，悬停给全路径', () => {
  assert.deepEqual(peekFor('Write', '{"file_path":"C:\\\\x\\\\docs\\\\big.md","content":"很长很长'),
    { text: '…\\docs\\big.md', path: 'C:\\x\\docs\\big.md' });
});

test('单条那一行：apply_patch 说改了哪几个文件，不是「*** Begin Patch」', () => {
  const patch = ['*** Begin Patch', '*** Update File: src/a.rs', '+y', '*** Add File: src/b.rs', '+x', '*** End Patch'].join('\n');
  assert.deepEqual(peekFor('apply_patch', patch), { text: 'src/a.rs 等 2 个文件', path: 'src/a.rs' });
});

test('单条那一行：Codex 的 exec 说里面调的那一下，不是一行 JS', () => {
  assert.deepEqual(peekFor('exec', 'const r = await tools.exec_command({cmd:"npm test -- coupon",workdir:"C:\\\\x"}); text(r)'),
    { text: 'npm test -- coupon', path: null });
  assert.equal(peekFor('exec', 'const r = await tools.web__run({search_query:[{q:"codex tui"}]}); text(r)').text, 'codex tui');
  assert.deepEqual(peekFor('exec', 'await tools.apply_patch("*** Begin Patch\\n*** Add File: work/inv.mjs\\n+x\\n*** End Patch")'),
    { text: 'work/inv.mjs', path: 'work/inv.mjs' });
  // 一个工具都不调的那种（在翻工具清单）没有更好的说法，照旧给代码
  assert.equal(peekFor('exec', 'text(ALL_TOOLS.map(x => x.name))').text, 'text(ALL_TOOLS.map(x => x.name))');
});

test('单条那一行：结构化的输入照旧走 tools.ts 那一套', () => {
  assert.deepEqual(peekFor('Read', { file_path: 'C:\\a\\b\\c\\d.ts' }), { text: '…\\c\\d.ts', path: 'C:\\a\\b\\c\\d.ts' });
  assert.deepEqual(peekFor('Bash', { command: 'npm test' }), { text: 'npm test', path: null });
  assert.equal(peekFor('shell_command', '{"command":"Get-ChildItem src","workdir":"C:\\\\x"}').text, 'Get-ChildItem src');
});

test('Antigravity：工具归类、统计话术与单条摘要', () => {
  assert.equal(
    say(
      ['read_file', { Path: 'c:\\repo\\src\\a.js' }],
      ['edit_file', { Path: 'c:\\repo\\src\\a.js', Target: '1', Replacement: '2' }],
      ['write_file', { Path: 'c:\\repo\\src\\b.js', Content: 'x' }],
      ['run_command', { CommandLine: 'npm test' }],
      ['grep_search', { Query: 'antigravity', SearchPath: 'c:\\repo\\src' }],
      ['search_web', { Query: 'antigravity cli' }],
      ['invoke_subagent', { Role: 'Codebase Researcher', TypeName: 'research' }],
    ),
    '读了 1 个文件、搜了 1 次、改了 2 个文件、跑了 1 条命令、上网查了 1 次、派了 1 个子 agent',
  );
  assert.equal(doingOf([call('run_command', { CommandLine: 'npm run check' })]), '跑 npm run check');
  assert.equal(doingOf([call('read_file', { Path: 'c:\\repo\\src\\a.js' })]), '读 a.js');
  assert.equal(doingOf([call('edit_file', { Path: 'c:\\repo\\src\\a.js' })]), '改 a.js');
  assert.equal(doingOf([call('invoke_subagent', { Role: 'Debugger' })]), '派子 agent：Debugger');
  assert.equal(doingOf([call('ask_question', { questions: [] })]), '等你回答');
  assert.deepEqual(peekFor('read_file', { Path: 'c:\\a\\b\\c.ts' }), { text: '…\\b\\c.ts', path: 'c:\\a\\b\\c.ts' });
  assert.equal(peekFor('run_command', { CommandLine: 'git status' }).text, 'git status');
});
