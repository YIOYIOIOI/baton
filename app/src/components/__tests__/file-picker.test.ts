import fs from 'node:fs';
import path from 'node:path';

/**
 * 网页端的加号**必须是一个真的 `<input type="file">`**，不能退回「藏一个 input
 * 再用 JS 合成点击它」。
 *
 * ## 为什么值得钉住（以及一条要说清的更正）
 *
 * 老做法押注三件事：浏览器认合成点击、认一个**没渲染**的 input、而且这一切
 * 发生在用户手势的激活窗口内。iOS 上已经因为最后一条咬过一次——失败方式还
 * 特别恶劣：**不报错、promise 也永远不 resolve**，界面上只是「点了没反应」，
 * 日志里干干净净。
 *
 * **更正：这不是 2026-09-20 那次的原因。** owner 的朋友在 /diag.html 上实测，
 * 她那台华为平板（HuaweiBrowser / Chrome 114）对合成点击是认的：
 *
 *     ① 真 input                                 → 能弹
 *     ② display:none + dispatchEvent(MouseEvent) → 也能弹（只是慢，6 秒超时先到了）
 *
 * 那次的真正原因是**新建会话屏上的加号压根没接回调**，于是它是灰的、点不动；
 * 而她是新访客、工作区是空的，唯一能进的就是那一屏。见 Composer 里 row 开头
 * 那段，和 new-session-plus 那组测试。
 *
 * 这组护栏留着，是因为那三个押注迟早还会咬人、而且失败是静默的——不是因为
 * 它是那次的根因。要改回去之前，先去 /diag.html 上拿证据。
 */

const DIR = path.join(__dirname, '..');
const COMPOSER = fs.readFileSync(path.join(DIR, 'Composer.tsx'), 'utf8');
const SESSION = fs.readFileSync(
  path.join(DIR, '..', 'app', 'session', '[key].tsx'), 'utf8',
);

/** 注释里会**讲到**旧做法（那段历史值得留着），查代码前先把注释剥掉。 */
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('新建会话那一屏也能带附件', () => {
  const NEW = code(fs.readFileSync(path.join(DIR, '..', 'app', 'new.tsx'), 'utf8'));

  /*
    这一组的前身钉的是相反的事：「那一屏两个回调都不传，所以加号别画」。
    那是 2026-09-20 的止血——owner 的朋友是新访客、工作区空的，唯一能进的就是
    那一屏，而那儿摆着一颗永远按不动的灰加号。

    owner 随后指出这本身就不合理：「文件为什么不能随着第一条消息发出去？或者说
    第一条消息为什么不能是单纯发文件？」——对的。那个限制只是实现顺序的限制
    （createSession 一次做完建会话+跑第一轮，而上传要 session key），
    不是产品该有的样子。所以现在那一屏真的能传了，这一组跟着换成钉新行为。
  */

  test('两个回调都传了，所以那颗加号是活的', () => {
    expect(NEW).toMatch(/onFiles=\{/);
    expect(NEW).toMatch(/onAttach=\{/);
  });

  test('点发送之前一个字节都不上传——只进缓存', () => {
    // owner：「把文件做一个类似缓存，如果点击发送，那就建会话发出去，
    // 用户如果中途退出，就取消」。退出就取消是这个设计自带的：那时候还没传。
    expect(NEW).toMatch(/setStaged\(\(prev\) => \[\.\.\.prev, \.\.\.stage\(pickedFromFiles\(files\)\)\]\)/);
    // onFiles 里不许直接上传
    const onFiles = /onFiles=\{([\s\S]*?)\}\n/.exec(NEW)?.[1] ?? '';
    expect(onFiles).not.toMatch(/upload/i);
  });

  test('发送时的顺序是「先传到 cwd、再带着路径建会话」', () => {
    const go = /async function go\(\)([\s\S]*?)\n  \}/.exec(NEW)?.[1] ?? '';
    expect(go).toBeTruthy();
    const up = go.indexOf('uploadStagedToCwd');
    const create = go.indexOf('createSession');
    expect(up).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    // agent 只认磁盘路径，路径必须在第一条消息里 —— 顺序反了就带不上
    expect(up).toBeLessThan(create);
    expect(go).toMatch(/attachmentSuffix\(/);
  });

  test('只发文件不写字也能发', () => {
    const go = /async function go\(\)([\s\S]*?)\n  \}/.exec(NEW)?.[1] ?? '';
    // 正文为空时用附件清单本身当第一条消息（非空，服务端那条 empty_message 才过）
    expect(go).toMatch(/!text && !staged\.length/);
    expect(go).toMatch(/text \? text \+ suffix : suffix\.trimStart\(\)/);
  });

  test('上传成功但建会话失败时，把已传的记回去，重试不重复上传', () => {
    const go = /async function go\(\)([\s\S]*?)\n  \}/.exec(NEW)?.[1] ?? '';
    expect(go).toMatch(/setStaged\(list\)/);
  });

  test('Composer 仍然只在有回调时才画加号 —— 别再出现按不动的灰加号', () => {
    expect(code(COMPOSER)).toMatch(/\{onAttach \|\| onFiles \?/);
  });

  test('会话屏照常有加号', () => {
    expect(code(SESSION)).toMatch(/onAttach=\{/);
  });
});

describe('网页端的加号', () => {
  test('底下压着一个真 input，而不是一颗按钮', () => {
    expect(code(COMPOSER)).toMatch(/createElement\(\s*'input'/);
  });

  test('那个 input 是渲染出来的，只是透明 —— 藏起来就退出命中测试了', () => {
    const c = code(COMPOSER);
    expect(c).toMatch(/opacity:\s*0/);
    // display:none / visibility:hidden 会让手指根本点不到它，那就回到原点
    expect(c).not.toMatch(/display:\s*'none'/);
    expect(c).not.toMatch(/visibility:\s*'hidden'/);
  });

  test('web 上按下加号不再去走 expo 的选择器', () => {
    // onPress 里遇到 web 必须直接返回：那一下是按在 input 上的，不归 Tappable 管
    expect(code(COMPOSER)).toMatch(/Platform\.OS === 'web'\)\s*return;/);
    // 会话页也不该再在 web 分支里主动开选择器
    expect(code(SESSION)).not.toMatch(/Platform\.OS === 'web'[^\n]*attach\('file'\)/);
  });

  test('文件从 onFiles 直接进上传，不经过 pick()', () => {
    expect(code(SESSION)).toMatch(/onFiles=\{attachFiles\}/);
    expect(code(SESSION)).toMatch(/uploadPicked\(client, key, pickedFromFiles\(files\)/);
  });
});
