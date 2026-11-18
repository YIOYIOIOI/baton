import { argOf, doingOf, failedOf, kindOf, liveLabel, segment, summarize, type Pair, type Seg } from '../runs';
import type { BatonEvent } from '../types';

/**
 * 会话流里「一段活」的折叠：怎么分段、折叠行那句话怎么数、跑着时说什么。
 *
 * **为什么值得测**：2026-10-10 拿真实 transcript 对着 Claude Code 桌面版对账，
 * 网页端旧的那版错了五处（web/src/runs.ts 抬头），这边的 TurnSummary 是同一份逻辑：
 *
 *   1. 「共 N 次工具调用」是总数，命令算了两遍——Claude 写的是「Ran a command, used 3 tools」
 *   2. 「改了 2 个文件」其实是同一个 daily.py 改了两次
 *   3. 命令只认 Bash 和 exec：PowerShell（实测 865 次）、Codex 的 shell_command（5624 次）没算
 *   4. Codex 的 run 是上网，exec 是一段 JS——里面调的可能是上网、改文件
 *   5. 思考把一段活切成好几行
 *
 * 两端不共享代码（docs/superpowers/specs/2026-09-14-baton-desktop-web-design.md §2），
 * 所以这里是同一套规则的另一份：数法和运行指示的用例与网页端那份（test/web-runs.test.js）
 * 一一对应。分段有两处是 App 自己的——落单的结果留在这段活里（网页端单独一行），
 * 每段记着盖住了哪些事件（「重连后补上」那条线要用）——那几条只在这边。
 */

let seq = 0;
function ev(over: Partial<BatonEvent>): BatonEvent {
  seq += 1;
  return { id: `e${seq}`, ts: null, role: 'agent', kind: 'text', offset: seq, ...over } as BatonEvent;
}
const said = (text: string) => ev({ kind: 'text', role: 'user', text });
const wrote = (text: string) => ev({ kind: 'text', role: 'agent', text });
const thought = (text = '先看看') => ev({ kind: 'thinking', role: 'agent', text });
function call(name: string | null, input: unknown): BatonEvent {
  return ev({ kind: 'tool_call', role: 'agent', tool: { id: `t${seq + 1}`, name, input } });
}
const result = (c: BatonEvent, output = 'ok') =>
  ev({ kind: 'tool_result', role: 'system', tool: { id: c.tool!.id, name: null, output } });

/** 一串调用，各配上结果 */
function calls(...specs: [string | null, unknown][]): BatonEvent[] {
  return specs.flatMap(([name, input]) => {
    const c = call(name, input);
    return [c, result(c)];
  });
}

type CallsSeg = Extract<Seg, { kind: 'calls' }>;
const runsOf = (segs: Seg[]) => segs.filter((s): s is CallsSeg => s.kind === 'calls');
const pairsOf = (seg: CallsSeg): Pair[] => seg.steps.flatMap((s) => (s.t === 'call' ? [s.pair] : []));
const say = (...specs: [string | null, unknown][]) => summarize(pairsOf(runsOf(segment(calls(...specs)))[0]));

const bash = (command: string): [string, unknown] => ['Bash', { command }];
const edit = (file_path: string): [string, unknown] => ['Edit', { file_path, old_string: 'a', new_string: 'b' }];
const read = (file_path: string): [string, unknown] => ['Read', { file_path }];
const mcp = (tool: string): [string, unknown] => [`mcp__ccd_session_mgmt__${tool}`, { query: 'x' }];

// ── 分段 ────────────────────────────────────────

test('思考不切断一段活：两段正文之间只有一行', () => {
  const segs = segment([
    said('改一下'),
    ...calls(bash('pytest'), bash('pytest -k a')),
    thought(),
    ...calls(edit('C:\\x\\daily.py')),
    thought(),
    ...calls(bash('pytest')),
    wrote('两条都红。'),
  ]);
  expect(segs.map((s) => s.kind)).toEqual(['one', 'calls', 'one']);
  expect((segs[1] as CallsSeg).steps.map((s) => s.t)).toEqual(['call', 'call', 'think', 'call', 'think', 'call']);
});

test('只有思考、没有工具的那段不折，仍是一条条思考', () => {
  const segs = segment([said('在吗'), thought('想一下'), wrote('在。')]);
  expect(segs.map((s) => (s.kind === 'one' ? s.event.kind : 'calls'))).toEqual(['text', 'thinking', 'text']);
});

test('正常结束的 turn_end 不占行也不切断；出错的才单独一条', () => {
  const ok = ev({ kind: 'turn_end', role: 'system' });
  const bad = ev({ kind: 'turn_end', role: 'system', error: 'Selected model is at capacity' });
  expect(segment([...calls(bash('a')), ok, ...calls(bash('b'))]).map((s) => s.kind)).toEqual(['calls']);
  expect(segment([...calls(bash('a')), bad, ...calls(bash('b'))]).map((s) => s.kind)).toEqual(['calls', 'one', 'calls']);
});

test('中断标记切断一段活', () => {
  const stop = ev({ kind: 'interrupt', role: 'system', text: '这一轮被中途打断' });
  expect(segment([...calls(bash('a')), stop, ...calls(bash('b'))]).map((s) => s.kind)).toEqual(['calls', 'one', 'calls']);
});

test('落单的结果仍在这段活里显示，不丢掉', () => {
  // 那一页恰好从调用和结果中间切开时会这样。丢掉等于悄悄藏起一段真实发生过的输出
  const orphan = ev({ kind: 'tool_result', role: 'system', tool: { id: 'nope', name: null, output: 'x' } });
  const segs = segment([orphan, ...calls(bash('a'))]);
  expect(segs.map((s) => s.kind)).toEqual(['calls']);
  expect(pairsOf(segs[0] as CallsSeg)[0].call).toBe(orphan);
});

test('结果按 tool.id 配回自己的调用，并行调用也不串', () => {
  const a = call('Bash', { command: 'a' });
  const b = call('Read', { file_path: 'x' });
  const pairs = pairsOf(segment([a, b, result(b, 'B'), result(a, 'A')])[0] as CallsSeg);
  expect(pairs.map((p) => p.result?.tool?.output)).toEqual(['A', 'B']);
});

test('每一段记着它盖住的事件 id——「重连后补上」那条线要能落在一段活的任何一步上', () => {
  // 补回来的第一条可能是这段活中间的一次调用、一段思考，或者被吞掉的正常 turn_end
  const c1 = call('Bash', { command: 'a' });
  const r1 = result(c1);
  const think = thought();
  const ok = ev({ kind: 'turn_end', role: 'system' });
  const c2 = call('Bash', { command: 'b' });
  const segs = segment([said('x'), c1, r1, think, ok, c2]);
  const run = segs[1];
  for (const e of [c1, r1, think, ok, c2]) expect(run.ids).toContain(e.id);
  // 正文后面的正常 turn_end 没有一段活可并：它自己一段，画出来什么都没有——
  // 但补回来的那批若正好从它开始，分界线得有个地方落
  const done = ev({ kind: 'turn_end', role: 'system' });
  const after = segment([wrote('好了'), done, said('再来')]);
  expect(after[1]).toMatchObject({ kind: 'one', ids: [done.id] });
});

test('只有思考的那段拆回去时，夹在里面的正常 turn_end 也按原来的位置回去', () => {
  const think = thought();
  const ok = ev({ kind: 'turn_end', role: 'system' });
  const segs = segment([said('在吗'), think, ok, wrote('在。')]);
  expect(segs.map((s) => s.ids)).toEqual([[segs[0].ids[0]], [think.id], [ok.id], [segs[3].ids[0]]]);
});

// ── 折叠行那句话 ────────────────────────────────

test('「其他」只数剩下的，不把命令再算一遍', () => {
  expect(say(mcp('search_session_transcripts'), bash('git remote -v'), mcp('search_session_transcripts'), mcp('search_session_transcripts')))
    .toBe('跑了 1 条命令、用了 3 次其他工具');
});

test('改文件按文件数：同一个文件改两次是「改了 1 个文件」', () => {
  expect(say(edit('C:\\workspace\\proj\\script.py'), edit('C:\\workspace\\proj\\script.py'), bash('a'), bash('b'), bash('c')))
    .toBe('改了 1 个文件、跑了 3 条命令');
});

test('路径的大小写和斜杠方向不同也是同一个文件', () => {
  expect(say(edit('C:\\X\\a.py'), edit('c:/x/a.py'))).toBe('改了 1 个文件');
});

test('读文件按文件数，搜索按次数', () => {
  expect(say(read('/r/a.ts'), read('/r/a.ts'), read('/r/b.ts'), ['Grep', { pattern: 'TODO' }], ['Glob', { pattern: '**/*.ts' }]))
    .toBe('读了 2 个文件、搜了 2 次');
});

test('Windows 上 Claude 的 PowerShell 算命令', () => {
  expect(say(['PowerShell', { command: 'Get-Process' }], bash('ls'))).toBe('跑了 2 条命令');
});

test('一句话里的先后固定：读 → 搜 → 改 → 跑 → 上网 → 子 agent → 问 → 其他', () => {
  expect(say(
    ['mcp__chrome-devtools__take_screenshot', {}],
    ['AskUserQuestion', { questions: [{ question: 'a?' }, { question: 'b?' }] }],
    ['Agent', { description: '复查', prompt: '…' }],
    ['WebSearch', { query: 'x' }],
    bash('npm test'),
    ['Write', { file_path: '/r/new.ts', content: 'x' }],
    ['Grep', { pattern: 'x' }],
    read('/r/a.ts'),
  )).toBe('读了 1 个文件、搜了 1 次、改了 1 个文件、跑了 1 条命令、上网查了 1 次、派了 1 个子 agent、问了你 2 个问题、用了 1 次其他工具');
});

test('只有其他工具时不说「其他」', () => {
  expect(say(mcp('list_events'), mcp('list_sessions'))).toBe('用了 2 次工具');
});

test('工具名缺失也算一次，不从计数里消失', () => {
  expect(say([null, { x: 1 }], bash('a'))).toBe('跑了 1 条命令、用了 1 次其他工具');
});

test('Write 的输入被截断成半截 JSON 时，照样认得出是哪个文件', () => {
  const cut = '{"file_path":"C:\\\\x\\\\big.md","content":"很长很长';
  expect(say(['Write', cut], ['Write', { file_path: 'C:\\x\\big.md', content: '' }])).toBe('改了 1 个文件');
});

test('落单的结果算一次其他工具——它也是这段活里的一步', () => {
  const orphan = ev({ kind: 'tool_result', role: 'system', tool: { id: 'nope', name: null, output: 'x' } });
  expect(summarize(pairsOf(segment([orphan, ...calls(bash('a'))])[0] as CallsSeg))).toBe('跑了 1 条命令、用了 1 次其他工具');
});

// ── Codex ───────────────────────────────────────

test('Codex：shell_command 是命令，run 是上网', () => {
  expect(say(
    ['shell_command', '{"command":"Get-ChildItem","workdir":"C:\\\\x"}'],
    ['run', '{"search_query":[{"q":"codex tui"}],"response_length":"short"}'],
    ['run', '{"open":[{"ref_id":"https://example.com"}]}'],
  )).toBe('跑了 1 条命令、上网查了 2 次');
});

test('Codex：apply_patch 按补丁里的文件数', () => {
  const patch = ['*** Begin Patch', '*** Update File: src/a.rs', '-x', '+y', '*** Add File: src/b.rs', '+fn main() {}',
    '*** Update File: src/a.rs', '*** End Patch'].join('\n');
  expect(say(['apply_patch', patch])).toBe('改了 2 个文件');
});

test('Codex：exec 是一段 JS，按它里面调的工具分', () => {
  const cmd = 'const r = await tools.exec_command({cmd:"Get-Content -Raw \'C:\\\\x\\\\a.md\'",workdir:"C:\\\\x"}); text(r)';
  const web = 'const r = await tools.web__run({search_query:[{q:"x"}]}); text(r)';
  const patch = 'const patch = "*** Begin Patch\\n*** Add File: work/inv.mjs\\n+import fs from \\"node:fs\\";\\n*** End Patch"; await tools.apply_patch(patch)';
  const look = 'text(ALL_TOOLS.filter(x => /shell/.test(x.name)).map(x => x.name));';
  expect(say(['exec', cmd], ['exec', web], ['exec', look])).toBe('跑了 1 条命令、上网查了 1 次、用了 1 次其他工具');
  expect(say(['exec', patch])).toBe('改了 1 个文件');
});

test('Codex：老版本的 exec 是一条裸命令，照旧算命令', () => {
  expect(say(['exec', 'Get-Process -Name claude'])).toBe('跑了 1 条命令');
});

test('Codex：spawn_agent 是派子 agent，wait_agent 之类的调度不算「派」', () => {
  expect(say(['spawn_agent', '{"task_name":"audit"}'], ['wait_agent', '{}'], ['send_message', '{}']))
    .toBe('派了 1 个子 agent、用了 2 次其他工具');
});

test('图标和那句话用同一套分类', () => {
  expect(kindOf('PowerShell', { command: 'x' })).toBe('shell');
  expect(kindOf('run', '{"search_query":[]}')).toBe('web');
  expect(kindOf('exec', 'await tools.apply_patch("*** Begin Patch")')).toBe('edit');
  expect(kindOf('Grep', { pattern: 'x' })).toBe('search');
  expect(kindOf('mcp__chrome-devtools__click', {})).toBe('other');
  expect(kindOf(null, {})).toBe('other');
});

// ── 跑着的时候说什么 ────────────────────────────

test('运行指示：最近一次调用还没结果，就说那一步，用人话', () => {
  // 旧版是 `正在跑 ${name}(${首行})`：Codex 的输入是一段 JS 或一串 JSON，
  // 于是手机上是「正在跑 exec(const r = await tools.exec_command({cmd:"…」
  expect(doingOf([call('Bash', { command: 'cd /c/workspace/proj && python script.py' })])).toBe('跑 cd /c/workspace/proj && python script.py');
  expect(doingOf([call('Read', { file_path: 'C:\\shop\\src\\coupon.ts' })])).toBe('读 coupon.ts');
  expect(doingOf([call('Edit', { file_path: '/shop/src/coupon.ts' })])).toBe('改 coupon.ts');
  expect(doingOf([call('Grep', { pattern: 'expired' })])).toBe('搜 expired');
  expect(doingOf([call('WebSearch', { query: 'codex tui exec cell' })])).toBe('上网查 codex tui exec cell');
  expect(doingOf([call('Agent', { description: '独立复查', prompt: '…' })])).toBe('派子 agent：独立复查');
  expect(doingOf([call('mcp__chrome-devtools__take_screenshot', {})])).toBe('用 chrome-devtools · take_screenshot');
});

test('运行指示：Codex 的 exec 格子说出里面那条命令', () => {
  const code = 'const r = await tools.exec_command({cmd:"npm test -- coupon",workdir:"C:\\\\x"}); text(r)';
  expect(doingOf([call('exec', code)])).toBe('跑 npm test -- coupon');
  expect(doingOf([call('shell_command', '{"command":"Get-ChildItem src"}')])).toBe('跑 Get-ChildItem src');
});

test('运行指示：两步之间说它在想——调用回来以后不能还停在那条命令上', () => {
  // 旧版只在有新调用进来时改这一行，之后再没人清它：命令跑完、agent 已经在写正文了，
  // 末尾那行还是「正在跑 Bash(…)」
  const c = call('Bash', { command: 'a' });
  expect(doingOf([c, result(c)])).toBe('在想下一步');
  expect(doingOf([c, result(c), thought()])).toBe('在思考');
  expect(doingOf([said('改一下')])).toBe('刚开始');
  expect(doingOf([said('改一下'), wrote('好的，先看看。')])).toBe('在想下一步');
  // 正常的 turn_end 不算一步
  expect(doingOf([c, ev({ kind: 'turn_end', role: 'system' })])).toBe('跑 a');
  expect(doingOf([])).toBeNull();
});

test('运行指示：并行调用时说的是还没回来的那条，不是最后发出去的那条', () => {
  const a = call('Bash', { command: 'npm test' });
  const b = call('Read', { file_path: '/r/a.ts' });
  expect(doingOf([a, b, result(b)])).toBe('跑 npm test');
});

test('折叠行跑着的时候：最后一步是思考就说在思考，调用回来了就说在想下一步', () => {
  const c = call('Bash', { command: 'a' });
  const live = (...evs: BatonEvent[]) => liveLabel((segment(evs)[0] as CallsSeg).steps);
  expect(live(c)).toBe('正在跑命令');
  expect(live(c, result(c))).toBe('正在想下一步');
  expect(live(c, result(c), thought())).toBe('正在思考');
  expect(live(call('Edit', { file_path: 'a' }))).toBe('正在改文件');
  expect(live(call('run', '{"search_query":[]}'))).toBe('正在上网查');
});

// ── 成败：只认服务端给的标记 ────────────────────

test('失败只认服务端给的 tool.failed，输出里有没有 error、failed 不算数', () => {
  // 旧版在输出末尾找 error|failed|fatal|Traceback|not found。拿全量数据对过（服务端
  // src/claude.js 旁那条测试）：标红的十条里将近九条是冤枉的，真出错的又漏一半
  const c = call('Bash', { command: 'pytest' });
  const failed = ev({ kind: 'tool_result', role: 'system', tool: { id: c.tool!.id, name: null, output: 'Exit code 1', failed: true } });
  const noisy = ev({ kind: 'tool_result', role: 'system', tool: { id: c.tool!.id, name: null, output: 'errors: none\n0 failed\nfatal.log' } });
  expect(failedOf({ call: c, result: failed })).toBe(true);
  expect(failedOf({ call: c, result: noisy })).toBe(false);
  expect(failedOf({ call: c })).toBe(false); // 还没结果：不知道，不是失败
  expect(failedOf({ call: failed })).toBe(true); // 落单的结果自己就带着标记
});

// ── 单条调用那一行：工具名后面跟哪一截 ──────────

test('单条那一行：Codex 的入参是一串 JSON，要解开说里面那条命令', () => {
  // 旧版字符串原样取第一行，Codex 的每一次 shell_command 都是 {"command":"…","workdir":"…"}
  expect(argOf('shell_command', '{"command":"Get-ChildItem src","workdir":"C:\\\\x"}')).toBe('Get-ChildItem src');
  expect(argOf('Bash', { command: 'cd /r && npm test\necho done' })).toBe('cd /r && npm test');
});

test('单条那一行：文件只给最后两段——手机一行放不下整条路径，截掉的偏偏是文件名', () => {
  expect(argOf('Read', { file_path: 'C:\\workspace\\project-a\\pkg\\src\\worker_pkg\\actions.py' })).toBe('…\\worker_pkg\\actions.py');
  expect(argOf('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })).toBe('/r/a.ts');
});

test('单条那一行：输入被截断成半截 JSON 时照样认出文件和命令', () => {
  // src/wire.js 截断时先 stringify 再切，Write 的大文件、很长的 Bash 都会变成这样
  expect(argOf('Write', '{"file_path":"C:\\\\x\\\\docs\\\\big.md","content":"很长很长')).toBe('…\\docs\\big.md');
  expect(argOf('Bash', '{"command":"python - <<\'EOF\'\\nimport sys\\n……省略 900 字……')).toBe("python - <<'EOF'");
});

test('单条那一行：apply_patch 说改了哪几个文件，不是「*** Begin Patch」', () => {
  const patch = ['*** Begin Patch', '*** Update File: src/a.rs', '+y', '*** Add File: src/b.rs', '+x', '*** End Patch'].join('\n');
  expect(argOf('apply_patch', patch)).toBe('src/a.rs 等 2 个文件');
  expect(argOf('apply_patch', '*** Begin Patch\n*** Update File: src/a.rs\n*** End Patch')).toBe('src/a.rs');
});

test('单条那一行：Codex 的 exec 说里面调的那一下，不是一行 JS', () => {
  expect(argOf('exec', 'const r = await tools.exec_command({cmd:"npm test -- coupon",workdir:"C:\\\\x"}); text(r)')).toBe('npm test -- coupon');
  expect(argOf('exec', 'const r = await tools.web__run({search_query:[{q:"codex tui"}]}); text(r)')).toBe('codex tui');
  expect(argOf('exec', 'await tools.apply_patch("*** Begin Patch\\n*** Add File: work/inv.mjs\\n+x\\n*** End Patch")')).toBe('work/inv.mjs');
  expect(argOf('exec', 'Get-Process -Name claude')).toBe('Get-Process -Name claude');
});

test('单条那一行：搜索说搜什么，上网说查什么，子 agent 说派去干什么', () => {
  expect(argOf('Grep', { pattern: 'expired', path: 'C:\\shop\\src' })).toBe('expired');
  expect(argOf('WebSearch', { query: 'codex tui' })).toBe('codex tui');
  expect(argOf('WebFetch', { url: 'https://example.com/a', prompt: '…' })).toBe('https://example.com/a');
  expect(argOf('Agent', { description: '独立复查', prompt: '…' })).toBe('独立复查');
  expect(argOf('spawn_agent', '{"task_name":"/root/audit","message":"…"}')).toBe('/root/audit');
});

test('单条那一行：其余工具照旧挑一个像样的字段，什么都没有就留空', () => {
  expect(argOf('mcp__chrome-devtools__navigate_page', { url: 'http://localhost:5180' })).toBe('http://localhost:5180');
  expect(argOf('mcp__chrome-devtools__take_screenshot', { pageId: 1 })).toBe('{"pageId":1}');
  expect(argOf('wait_agent', '{}')).toBe('');
  expect(argOf(null, undefined)).toBe('');
});

test('Antigravity：工具归类、状态栏和参数提取', () => {
  const s = say(
    ['read_file', { Path: 'C:\\repo\\src\\a.ts' }],
    ['edit_file', { Path: 'C:\\repo\\src\\a.ts', Target: '1', Replacement: '2' }],
    ['run_command', { CommandLine: 'npm test' }],
    ['invoke_subagent', { Role: 'Reviewer' }],
  );
  expect(s).toBe('读了 1 个文件、改了 1 个文件、跑了 1 条命令、派了 1 个子 agent');
  expect(doingOf([call('run_command', { CommandLine: 'git status' })])).toBe('跑 git status');
  expect(doingOf([call('write_file', { Path: 'C:\\repo\\b.ts', Content: 'x' })])).toBe('改 b.ts');
  expect(doingOf([call('ask_question', { questions: [] })])).toBe('等你回答');
  expect(argOf('read_file', { Path: 'C:\\repo\\src\\a.ts' })).toBe('…\\src\\a.ts');
  expect(argOf('search_web', { Query: 'baton antigravity' })).toBe('baton antigravity');
  expect(argOf('invoke_subagent', { Role: 'Researcher' })).toBe('Researcher');
});
