// 网页端工具载荷整形。
//
// 为什么这个测试在后端的 test/ 里而不是 web/ 自己的测试栈里：
// `web/src/tools.ts` 是**纯函数、无 React、无 DOM**，而 Node 24 能直接 import
// .ts（类型剥离）。挂进现有的 `npm test` 等于零新依赖、零新测试栈——
// 给它单独装一套 vitest 只为跑几十个断言，代价大于收益。
//
// 用例的输入形状**全部取自线上实测**（48 个会话、1371 个 tool_call、958 个
// tool_result 抽样），不是照文档编的。每一条上面写着它在实测里占多少。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coerce, displayName, pathOf, peekOf, shapeInput, shapeOutput, shortPath,
} from '../web/src/tools.ts';

/* ── 形状归一 ─────────────────────────────────────────────────────────────── */

test('coerce 解开「字符串里装 JSON」', () => {
  // codex 17% 的 input、claude 全部的 Write 都是这个形状
  assert.deepEqual(coerce('{"command":"ls"}'), { command: 'ls' });
  assert.deepEqual(coerce('[1,2]'), [1, 2]);
});

test('coerce 不碰普通字符串', () => {
  // codex 的 exec 八成是裸命令，不能被当成 JSON 试解析
  assert.equal(coerce('npm test'), 'npm test');
  assert.equal(coerce('echo hi'), 'echo hi');
});

test('coerce 对解析出标量的字符串保持原样', () => {
  // `"123"` 解析成 123 不叫「装着 JSON」，那会把一段文本变成数字
  assert.equal(coerce('"hello"'), '"hello"');
});

test('coerce 对被截断的半截 JSON 原样返回', () => {
  // wire.js:25 截断时先 JSON.stringify 再切片，回来的是解析不了的半截。
  // **这是期望行为，不是异常**——原样显示比猜一个结构诚实。
  const cut = '{"command":"cd \\"C:/x\\" && python - <<\'PY\'\\nimport io\\n\n\n……省略 9000 字……';
  assert.equal(coerce(cut), cut);
});

/* ── 工具名 ───────────────────────────────────────────────────────────────── */

test('displayName 拆开 MCP 长名', () => {
  assert.equal(displayName('mcp__chrome-devtools__evaluate_script'), 'chrome-devtools · evaluate_script');
  assert.equal(displayName('Bash'), 'Bash');
  // 实测 1137 个事件里 342 个 tool.name 是 null
  assert.equal(displayName(null), '工具');
  assert.equal(displayName(undefined), '工具');
});

/* ── 输入：shell（实测占 69%）──────────────────────────────────────────────── */

test('shell：命令从 JSON 里取出来，换行是真换行', () => {
  // claude Bash 实测 436 次，是所有工具里最高频的一格
  const s = shapeInput('Bash', { command: 'echo one\necho two', description: '跑两条' });
  assert.equal(s[0].label, '命令');
  assert.equal(s[0].kind, 'code');
  assert.equal(s[0].text, 'echo one\necho two'); // 不是 "echo one\\necho two"
  assert.equal(s[1].label, '说明');
  assert.equal(s[1].kind, 'note'); // 说明是给人读的句子，不套等宽
});

test('shell：codex 的裸字符串就是命令本身', () => {
  // codex exec 实测 405 次，83% 是这个形状
  const s = shapeInput('exec', 'Get-Process -Name claude');
  assert.equal(s.length, 1);
  assert.equal(s[0].text, 'Get-Process -Name claude');
});

test('shell：字符串装 JSON 先解开再取命令', () => {
  // codex shell_command 实测 65 次
  const s = shapeInput('shell_command', '{"command":"Get-Command drat-trim"}');
  assert.equal(s[0].label, '命令');
  assert.equal(s[0].text, 'Get-Command drat-trim');
});

test('shell：多出来的键照通用规则补上，短标量收成一行', () => {
  const s = shapeInput('Bash', { command: 'ls', timeout: 300000 });
  const t = s.find((x) => x.label === 'timeout');
  assert.equal(t.kind, 'inline'); // 一个数字不该占一整个代码块
  assert.equal(t.text, '300000');
});

test('shell：形状不合预期时退回通用，不硬凑', () => {
  // 没有 command/cmd/code/script 就不是我们认识的那种 shell 调用
  const s = shapeInput('Bash', { weird: 'x' });
  assert.equal(s[0].label, 'weird');
});

/* ── 输入：Edit（实测 117 次）──────────────────────────────────────────────── */

test('Edit 整形成一次替换的两侧', () => {
  const s = shapeInput('Edit', {
    file_path: 'C:\\x\\y.js', old_string: 'const a = 1', new_string: 'const a = 2', replace_all: false,
  });
  assert.deepEqual(s.map((x) => [x.label, x.kind]), [['删去', 'del'], ['换成', 'ins']]);
  assert.equal(s[0].text, 'const a = 1');
  assert.equal(s[1].text, 'const a = 2');
});

test('Edit 的 replace_all 只在为真时出现', () => {
  const on = shapeInput('Edit', { old_string: 'a', new_string: 'b', replace_all: true });
  assert.equal(on.at(-1).text, '全部替换');
  // false 是「没开」，不是一条信息——显示它等于给每个 Edit 加一行噪音
  const off = shapeInput('Edit', { old_string: 'a', new_string: 'b', replace_all: false });
  assert.equal(off.length, 2);
});

/* ── 输入：Write / Read ────────────────────────────────────────────────────── */

test('Write 的 input 是字符串装 JSON，仍能取到内容', () => {
  // 实测 48 次，claude 内部都不统一：Bash 给对象，Write 给字符串
  const s = shapeInput('Write', JSON.stringify({ file_path: 'C:\\a.js', content: 'line1\nline2' }));
  assert.equal(s.length, 1);
  assert.equal(s[0].label, '内容');
  assert.equal(s[0].text, 'line1\nline2');
});

test('Read 只剩路径时不产出任何段——路径已经在折叠行上了', () => {
  assert.deepEqual(shapeInput('Read', { file_path: 'C:\\a.txt' }), []);
  // 有附加项才给段
  const s = shapeInput('Read', { file_path: 'C:\\a.txt', offset: 100 });
  assert.equal(s.length, 1);
  assert.equal(s[0].label, 'offset');
});

/* ── 输入：通用长尾 ───────────────────────────────────────────────────────── */

test('通用整形：每个键各成一段，键名作标题', () => {
  const s = shapeInput('mcp__chrome-devtools__take_screenshot', { pageId: 1, format: 'jpeg', quality: 70 });
  assert.deepEqual(s.map((x) => x.label), ['pageId', 'format', 'quality']);
  assert.ok(s.every((x) => x.kind === 'inline')); // 全是短标量
});

test('通用整形：长值或多行值自己占一块', () => {
  const long = 'x'.repeat(200);
  const s = shapeInput('Whatever', { note: long, multi: 'a\nb' });
  assert.equal(s[0].kind, 'code');
  assert.equal(s[1].kind, 'code');
});

test('通用整形：空值不占版面', () => {
  const s = shapeInput('Whatever', { a: null, b: '', c: false, d: 'keep' });
  assert.deepEqual(s.map((x) => x.label), ['d']);
});

/* ── 输出 ─────────────────────────────────────────────────────────────────── */

test('输出：Claude 的内容块数组被拆成正文', () => {
  // 实测 claude 约 10% 的 tool_result 是这个形状；不拆的话 \n 全部以字面量显示
  const s = shapeOutput('[{"type":"text","text":"## Pages\\n1: about:blank"}]');
  assert.equal(s.length, 1);
  assert.equal(s[0].text, '## Pages\n1: about:blank');
});

test('输出：非 text 的块留一行占位，不假装能显示', () => {
  const s = shapeOutput([{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAA' }]);
  assert.equal(s[0].text, 'hi\n[image]');
});

test('输出：不是内容块的数组走通用，不被误拆', () => {
  const s = shapeOutput('[1,2,3]');
  assert.equal(s[0].text, JSON.stringify([1, 2, 3], null, 2));
});

test('输出：普通文本原样，换行保住', () => {
  // codex 99% 是这个形状
  const s = shapeOutput('Wall time: 1.2s\nOutput:\nok');
  assert.equal(s[0].text, 'Wall time: 1.2s\nOutput:\nok');
});

test('输出：空的就是空的，不产出「（空）」占位', () => {
  assert.deepEqual(shapeOutput(''), []);
  assert.deepEqual(shapeOutput(null), []);
});

/* ── 折叠行 ───────────────────────────────────────────────────────────────── */

test('peek 给的是命令本身，不是 JSON 开头', () => {
  // 改之前这里是 `{ "command": "echo \"===` —— 既认不出是哪条命令，又占满整行
  const p = peekOf('Bash', { command: 'echo "=== a ==="; curl -s http://x', description: 'check' });
  assert.equal(p, 'echo "=== a ==="; curl -s http://x');
});

test('peek 对文件类工具给路径——人是靠「哪个文件」认的', () => {
  assert.equal(peekOf('Edit', { file_path: 'C:\\a\\b\\c\\d.js', old_string: 'x', new_string: 'y' }), '…\\c\\d.js');
  assert.equal(peekOf('Read', { file_path: '/home/u/p/q.txt' }), '…/p/q.txt');
});

test('peek 折行压成一行并截断', () => {
  const p = peekOf('exec', 'a\n'.repeat(400));
  assert.ok(!p.includes('\n'));
  assert.ok(p.length <= 161, `实际 ${p.length}`);
  assert.ok(p.endsWith('…'));
});

test('peek 对 Edit 取「删去」那一侧而不是空', () => {
  // Edit 没有 file_path 时仍要有话说
  assert.equal(peekOf('Edit', { old_string: 'const a = 1', new_string: 'const a = 2' }), 'const a = 1');
});

test('shell 类即便带 path 也给命令，不给路径', () => {
  // `cd` 到某处的命令里常有 path 字段，但人认的是命令
  assert.equal(peekOf('Bash', { command: 'ls -la', path: '/tmp' }), 'ls -la');
});

/* ── 路径 ─────────────────────────────────────────────────────────────────── */

test('pathOf 只在真有路径时给值', () => {
  assert.equal(pathOf({ file_path: 'C:\\a.js' }), 'C:\\a.js');
  assert.equal(pathOf({ path: '/x' }), '/x');
  assert.equal(pathOf('just a string'), null);
  assert.equal(pathOf({ command: 'ls' }), null);
});

test('shortPath 留末尾两段，短路径不动', () => {
  assert.equal(shortPath('C:\\a\\b\\c\\d.js'), '…\\c\\d.js');
  assert.equal(shortPath('/a/b/c.txt'), '…/b/c.txt');
  assert.equal(shortPath('a/b'), 'a/b'); // 两段以内原样
  assert.equal(shortPath('d.js'), 'd.js');
});

/* ── 全流程：截断 → 取回全文 → 重新整形 ───────────────────────────────────── */

test('被截断时原样显示，取回全文后自动整形成命令', () => {
  const real = { command: 'echo one\necho two', description: '两条' };
  const whole = JSON.stringify(real);

  // 截断态：wire.js 切过的半截，解析不了 → 一段原样文本
  const cut = `${whole.slice(0, 20)}\n\n……省略 N 字……\n\n${whole.slice(-10)}`;
  const before = shapeInput('Bash', cut);
  assert.equal(before.length, 1);
  assert.equal(before[0].label, '输入');
  assert.equal(before[0].text, cut);

  // 取回全文后是完整的 JSON.stringify 输出 → 同一个函数就整形成功了，
  // 不需要为「全文」单开一条代码路径
  const after = shapeInput('Bash', whole);
  assert.equal(after[0].label, '命令');
  assert.equal(after[0].text, 'echo one\necho two');
});

test('Antigravity：edit_file / write_file / run_command / pathOf 整形', () => {
  const ed = shapeInput('edit_file', {
    Path: 'c:\\repo\\a.js', Target: 'old()', Replacement: 'new()',
  });
  assert.deepEqual(ed.map((x) => [x.label, x.kind, x.text]), [
    ['删去', 'del', 'old()'],
    ['换成', 'ins', 'new()'],
  ]);
  const wr = shapeInput('write_file', { Path: 'c:\\repo\\b.js', Content: 'console.log(1)\n' });
  assert.equal(wr[0].label, '内容');
  assert.equal(wr[0].text, 'console.log(1)\n');
  const sh = shapeInput('run_command', { CommandLine: 'npm test', toolSummary: 'Run tests' });
  assert.deepEqual(sh.map((x) => [x.label, x.text]), [['命令', 'npm test'], ['说明', 'Run tests']]);
  assert.equal(pathOf({ Path: 'c:\\repo\\a.js' }), 'c:\\repo\\a.js');
  assert.equal(pathOf({ TargetFile: 'c:\\repo\\b.js' }), 'c:\\repo\\b.js');
  assert.equal(peekOf('read_file', { Path: 'c:\\repo\\src\\a.js' }), '…\\src\\a.js');
  assert.equal(peekOf('run_command', { CommandLine: 'echo ok' }), 'echo ok');
});
