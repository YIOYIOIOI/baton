import { classifyHref, parseBlocks, parseSpans } from '../markdown';

/**
 * markdown 解析器的测试。
 *
 * 只测两个纯函数（块级切分、行内切分），不测渲染：渲染要 mock 整个 RN，
 * 那套脚手架比被测逻辑还容易写错；而解析器才是真会出错的地方。
 */

// ── 块级 ────────────────────────────────────────

test('标题认 1–6 级，# 后面必须有空格', () => {
  expect(parseBlocks('# 一级')).toEqual([{ k: 'h', level: 1, text: '一级' }]);
  expect(parseBlocks('### 三级')).toEqual([{ k: 'h', level: 3, text: '三级' }]);
  // 没空格的不是标题，是正文里的井号（比如 issue 编号 #123）
  expect(parseBlocks('#123 不是标题')).toEqual([{ k: 'p', text: '#123 不是标题' }]);
});

test('围栏代码块里的 markdown 语法是内容，不是语法', () => {
  const src = ['前面', '```js', '// # 不是标题', 'const a = "**不是粗体**";', '```', '后面'].join('\n');
  expect(parseBlocks(src)).toEqual([
    { k: 'p', text: '前面' },
    { k: 'code', lang: 'js', text: '// # 不是标题\nconst a = "**不是粗体**";' },
    { k: 'p', text: '后面' },
  ]);
});

test('代码块没有收尾围栏也不能吞掉后面的一切', () => {
  // agent 的输出被截断时就是这样。至少要把已有内容作为代码块交出来，不能抛
  const r = parseBlocks('```\nfoo\nbar');
  expect(r).toEqual([{ k: 'code', lang: '', text: 'foo\nbar' }]);
});

// 列表项现在带着「是不是任务、缩进几层」，所以是对象不是字符串
const li = (text: string, depth = 0, task: boolean | null = null) => ({ text, task, depth });

test('无序列表：三种记号都认，缩进续行并进上一条', () => {
  expect(parseBlocks('- a\n* b\n+ c')).toEqual([{ k: 'ul', items: [li('a'), li('b'), li('c')] }]);
  expect(parseBlocks('- 很长的一条\n  接着上一条\n- 第二条'))
    .toEqual([{ k: 'ul', items: [li('很长的一条 接着上一条'), li('第二条')] }]);
});

test('有序列表：1. 和 1) 都认', () => {
  expect(parseBlocks('1. a\n2. b')).toEqual([{ k: 'ol', items: [li('a'), li('b')] }]);
  expect(parseBlocks('1) a\n2) b')).toEqual([{ k: 'ol', items: [li('a'), li('b')] }]);
});

test('嵌套列表按每 2 空格一级，续行仍并进上一条', () => {
  // 嵌套项必须先于「续行」判：反过来会把子项当成上一条的续行吞掉
  expect(parseBlocks('- 一\n  - 一甲\n- 二')).toEqual([
    { k: 'ul', items: [li('一'), li('一甲', 1), li('二')] },
  ]);
});

test('任务列表：勾与不勾都认，记号从正文里摘掉', () => {
  // agent 汇报进度默认就是这个形式，不认的话手机上看到的是一堆 `- [ ]`
  expect(parseBlocks('- [ ] 没做\n- [x] 做了\n- [X] 也做了')).toEqual([
    { k: 'ul', items: [li('没做', 0, false), li('做了', 0, true), li('也做了', 0, true)] },
  ]);
});

test('引用连续多行并成一块', () => {
  expect(parseBlocks('> 第一行\n> 第二行')).toEqual([{ k: 'quote', text: '第一行\n第二行' }]);
});

test('分隔线与「减号列表」不混淆', () => {
  expect(parseBlocks('---')).toEqual([{ k: 'hr' }]);
  expect(parseBlocks('- 一条')).toEqual([{ k: 'ul', items: [li('一条')] }]);
});

test('空行切段落，连续空行不产生空段落', () => {
  expect(parseBlocks('一段\n\n\n二段')).toEqual([
    { k: 'p', text: '一段' },
    { k: 'p', text: '二段' },
  ]);
});

test('CRLF 不影响解析', () => {
  expect(parseBlocks('# 标题\r\n\r\n正文')).toEqual([
    { k: 'h', level: 1, text: '标题' },
    { k: 'p', text: '正文' },
  ]);
});

// ── 行内 ────────────────────────────────────────

test('行内代码优先于强调——反引号里的星号是内容', () => {
  expect(parseSpans('`**x**`')).toEqual([{ k: 'code', text: '**x**' }]);
});

test('粗体、斜体、两种记号', () => {
  expect(parseSpans('**粗**')).toEqual([{ k: 'strong', text: '粗' }]);
  expect(parseSpans('__粗__')).toEqual([{ k: 'strong', text: '粗' }]);
  expect(parseSpans('*斜*')).toEqual([{ k: 'em', text: '斜' }]);
});

test('乘号不该被当成斜体', () => {
  // `a * b * c` 里的星号两侧都是空格，不是强调
  expect(parseSpans('a * b')).toEqual([{ k: 'text', text: 'a * b' }]);
});

test('链接：markdown 形式与裸 URL 都认', () => {
  expect(parseSpans('[名字](https://x.test/a)')).toEqual([
    { k: 'link', text: '名字', href: 'https://x.test/a' },
  ]);
  expect(parseSpans('https://x.test/a')).toEqual([
    { k: 'link', text: 'https://x.test/a', href: 'https://x.test/a' },
  ]);
});

test('相邻的纯文本会合并，不会一个字一个 span', () => {
  // 逐字符推进的实现如果不合并，一段话会产生几百个 Text 节点
  const r = parseSpans('这是一段没有任何标记的文字');
  expect(r).toHaveLength(1);
  expect(r[0]).toEqual({ k: 'text', text: '这是一段没有任何标记的文字' });
});

test('混合：文字 + 粗体 + 行内代码', () => {
  expect(parseSpans('把 `x` 改成 **y** 就行')).toEqual([
    { k: 'text', text: '把 ' },
    { k: 'code', text: 'x' },
    { k: 'text', text: ' 改成 ' },
    { k: 'strong', text: 'y' },
    { k: 'text', text: ' 就行' },
  ]);
});

test('未闭合的记号按原文处理，不吞掉后面的内容', () => {
  expect(parseSpans('**没闭合')).toEqual([{ k: 'text', text: '**没闭合' }]);
  expect(parseSpans('`没闭合')).toEqual([{ k: 'text', text: '`没闭合' }]);
});

// ── 表格 ────────────────────────────────────────

/**
 * 表格是后补的。原来的注释写着「agent 回复里极少」——错得很容易验证：
 * 这个仓库里 agent 写的文档、聊天里的对照说明，几乎每篇都有表格。
 * owner 在手机上看到的就是一堆 `| --- | --- |` 的原文。
 */
test('表格：首尾竖线可有可无，对齐记号都认', () => {
  expect(parseBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual([
    { k: 'table', head: ['a', 'b'], rows: [['1', '2']], align: ['left', 'left'] },
  ]);
  // 不带首尾竖线的写法 agent 也会产出
  expect(parseBlocks('a | b\n--- | ---\n1 | 2')).toEqual([
    { k: 'table', head: ['a', 'b'], rows: [['1', '2']], align: ['left', 'left'] },
  ]);
  expect(parseBlocks('| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |')[0]).toMatchObject({
    align: ['left', 'center', 'right'],
  });
});

test('只有下一行是分隔行才算表格', () => {
  // 「a | b 两种写法」这种普通句子里也有竖线，不能只看本行
  expect(parseBlocks('用 a | b 两种写法')).toEqual([{ k: 'p', text: '用 a | b 两种写法' }]);
  expect(parseBlocks('| a | b |\n| 不是分隔行 |')).toEqual([
    { k: 'p', text: '| a | b |\n| 不是分隔行 |' },
  ]);
});

test('列数对不齐时补空、截长，不丢内容也不撑歪', () => {
  // agent 手写的表格经常缺一格
  const t = parseBlocks('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |')[0];
  expect(t).toMatchObject({ rows: [['1', '', ''], ['1', '2', '3']] });
});

// ── 删除线与图片 ────────────────────────────────

test('删除线', () => {
  expect(parseSpans('~~没了~~')).toEqual([{ k: 'del', text: '没了' }]);
});

/**
 * 图片**退化成链接**，不真的加载：agent 回复里的图片链接多半指向那台电脑上的
 * 本地文件，手机上取不到，渲染成碎图标不如给一条能点的链接。
 */
test('图片变成链接，且不与普通链接混淆', () => {
  expect(parseSpans('![截图](/tmp/a.png)')).toEqual([
    { k: 'link', text: '图 截图', href: '/tmp/a.png' },
  ]);
  expect(parseSpans('![](/tmp/a.png)')).toEqual([
    { k: 'link', text: '图片', href: '/tmp/a.png' },
  ]);
  expect(parseSpans('[文字](/x)')).toEqual([{ k: 'link', text: '文字', href: '/x' }]);
});

test('classifyHref 只允许 http/https/mailto 作为外链，拦截危险协议', () => {
  expect(classifyHref('https://example.com/a')).toBe('external');
  expect(classifyHref('http://127.0.0.1:3002/pair')).toBe('external');
  expect(classifyHref('mailto:user@example.com')).toBe('external');

  expect(classifyHref('javascript:alert(1)')).toBe('blocked');
  expect(classifyHref('javascript://%0aalert(1)')).toBe('blocked');
  expect(classifyHref('JAVASCRIPT:void(0)')).toBe('blocked');
  expect(classifyHref('data:text/html,<script>alert(1)</script>')).toBe('blocked');
  expect(classifyHref('tel:12345')).toBe('blocked');
  expect(classifyHref('#sec')).toBe('blocked');
  expect(classifyHref('')).toBe('blocked');

  expect(classifyHref('src/index.ts:42')).toBe('file');
  expect(classifyHref('./README.md')).toBe('file');
  expect(classifyHref('C:\\proj\\a.ts')).toBe('file');
});
