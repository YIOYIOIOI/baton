import fs from 'node:fs';
import path from 'node:path';

/**
 * 入口守卫的结构性检查。
 *
 * 列表屏有一个三态：`authed` 是 null（还没问过）/ true / false。
 * null 时渲染空白等结果——**所以每一条退出路径都必须把它置成 true 或 false**，
 * 漏一条就是白屏不动，而白屏不动正是 Baton 立项要消灭的那种失败。
 *
 * 用源码检查而不是渲染测试：要真渲染就得把 zustand、expo-router、SecureStore
 * 全都 mock 一遍，那套脚手架本身比被测逻辑还容易写错。
 *
 * 测试放在 src/__tests__ 而不是 src/app/__tests__：**app/ 底下的一切都会被
 * expo-router 当成路由**——挪之前 `.expo/types/router.d.ts` 里确实生成了
 * `/__tests__/gate.test` 这样的路径。产物里没扫到测试代码，但让路由表长出
 * 一堆假路由本身就是隐患。
 */
const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', '(tabs)', 'index.tsx'),
  'utf8',
);

test('没有 client 时必须判未配对，不能直接 return', () => {
  // 原生端首次启动就是这个状态：还没配过对，没有地址可连。
  // 初版写的是 `if (!client) return;`，authed 永远停在 null → 白屏。
  const m = /if \(!client\)\s*\{?([^\n]*)/.exec(src);
  expect(m).toBeTruthy();
  expect(m![1]).toContain('setAuthed(false)');
});

test('凭据还没读回来时不许判未配对——那是「还不知道」，不是「没配对」', () => {
  // 上一条的反方向。只有上一条时：冷启动瞬间 client 还是 null，于是立刻
  // setAuthed(false) → 重定向走，而其实早就配好了。
  // 浏览器实测过：/api/sessions 返回 200，页面却跳去了配对流程。
  // 两条必须同时在，且 !ready 要排在 !client 前面。
  const readyIdx = src.indexOf('if (!ready) return;');
  const clientIdx = src.indexOf('if (!client)');
  expect(readyIdx).toBeGreaterThan(-1);
  expect(readyIdx).toBeLessThan(clientIdx);

  // ready 变化时必须重新判一次，否则永远停在「还没问过」= 白屏
  expect(src).toMatch(/useEffect\(\(\) => \{ load\(\); \}, \[client, ready\]\)/);
});

test('未配对时去首屏，不是直接甩到配对页', () => {
  // 首屏是 owner 点名要复刻的那一屏，它下面才是「连接电脑」。
  // 直接跳配对页会让人一上来就看见一个空的验证码框，不知道这是什么东西。
  expect(src).toMatch(/if \(!authed\) return <Redirect href="\/welcome" \/>/);
});

test('渲染分支对 authed 的三态都有交代', () => {
  expect(src).toContain('authed === null');   // 还没问过 → 等
  expect(src).toContain('if (!authed)');      // 问过且不认 → 去配对
});

test('只有 401 才判未配对，网络故障不判', () => {
  // 把「连不上」当成「没配对」会让人白白重配一次，而问题根本不在那儿
  expect(src).toMatch(/e\.status === 401.*setAuthed\(false\)/s);
});

const pairSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'pair.tsx'), 'utf8');

test('网页端不再问地址——页面就是 Baton 发的，地址栏里写着', () => {
  // owner 第一眼就说「配对码上面还要输入一个网址，逻辑很怪」。确实怪：
  // 那是原生端的需要，网页端不该背这个包袱。
  // 判据必须是**编译期就定死的** Platform.OS，不能用 pageOrigin()：
  // Expo 的静态渲染跑在 Node 里，那时没有 location，pageOrigin() 返回 null，
  // 地址框会被预渲染进 HTML，等浏览器接管后再消失——闪一下。
  expect(pairSrc).toMatch(/const isWeb = Platform\.OS === 'web'/);
  expect(pairSrc).toMatch(/\{isWeb \? null : \(/);          // 网页端不渲染地址框
  expect(pairSrc).toMatch(/pair\(origin \?\? url, code\)/); // 真正的地址仍从 location 取
});

test('原生端地址仍然参与可用性判断', () => {
  // 原生端不问就不知道连哪台电脑，那个框不能跟着一起砍掉
  expect(pairSrc).toMatch(/\(isWeb \|\| url\.trim\(\)\.length > 0\)/);
});

const liveSrc = fs.readFileSync(
  path.join(__dirname, '..', 'store', 'useSessionLive.ts'),
  'utf8',
);

/**
 * 断流在手机上是常态：锁屏、切后台、进隧道、Wi-Fi 切蜂窝。
 * 没有重连的话界面会正确地冻住然后**永远停在那儿**——等于把一个本来能
 * 自愈的故障做成了要人工干预的故障。初版就是这样，这几条守住修复。
 */
test('流断了要退避重连，而不是只报个错就算', () => {
  expect(liveSrc).toMatch(/schedule\(\)/);                  // 出错时排下一次
  expect(liveSrc).toMatch(/Math\.min\(30_000/);             // 退避封顶
  expect(liveSrc).toMatch(/attempt = 0/);                   // 听到服务器就清零
});

test('回到前台立刻重连，但只是加速，不是依赖', () => {
  // 光靠退避的话，睡了一夜回来还要再等 30 秒。
  // 但**不能只靠它**——iOS 主屏应用里 visibilitychange 什么时候发不由我担保，
  // 真正兜底的是下面那条看门狗。
  expect(liveSrc).toMatch(/AppState\.addEventListener/);
  expect(liveSrc).toMatch(/s === 'active'\) reconnectNow\(\)/);
  expect(liveSrc).toMatch(/const reconnectNow/);
});

test('重连后要补拉一次——SSE 不重发断开期间的事件', () => {
  // follower 从「订阅那一刻的文件末尾」开始跟，不补就是一段悄无声息的空洞
  expect(liveSrc).toMatch(/const resync = async/);
  expect(liveSrc).toMatch(/timer = setTimeout\(\(\) => \{ timer = null; resync\(\); connect\(\); \}/);
});

test('卸载时一定要停掉，否则每次进出会话都泄漏一条流', () => {
  expect(liveSrc).toMatch(/stopped = true/);
  expect(liveSrc).toMatch(/sub\.remove\(\)/);
  expect(liveSrc).toMatch(/stop\?\.\(\)/);
});

/**
 * 列表一行只有圆点和标题，没有任何状态文字——「在跑」全靠那颗点。
 * 初版它永远是空心的：后端不给 running，客户端也没接。等于设计里最重要的
 * 那一路信号整个是死的。
 */
test('列表的圆点要真的接上运行态', () => {
  // 判定 2026-10-08 挪进了 api/groups.ts 的 dotKind（三态了，那边有单测）；
  // 这里守的是「这一屏真的用了它、而且在跑的那颗是会动的」
  expect(src).toMatch(/dotKind\(m, link\)/);
  expect(src).toMatch(/<Pulse style=\{\[s\.rowDot/);
});

test('传输轴死了圆点不许继续呼吸', () => {
  // 那一刻「它在跑」这个判断本身已经不可信，继续呼吸就是在说谎
  const groupsSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'groups.ts'), 'utf8');
  expect(groupsSrc).toMatch(/if \(link !== 'ok'\) return 'idle'/);
});

const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'ui.tsx'), 'utf8');

test('浮动顶栏必须避开灵动岛/刘海', () => {
  // owner 实测：顶栏贴在 top:0，右边那颗按钮正好落在灵动岛底下，点不到。
  // 这块高度按机型 20pt 到 59pt 不等，写死任何一个数都会在别的机型上错。
  expect(uiSrc).toMatch(/useSafeAreaInsets/);
  expect(uiSrc).toMatch(/paddingTop: inset\.top \+ 8/);
  expect(uiSrc).toMatch(/export function useFloatBarHeight/);
});

// 去掉 \r 再匹配：git 在 Windows 上按 core.autocrlf 检出成 CRLF，
// 于是 `\}\n` 这种模式匹配不到 `}\r\n`，测试会因为**行尾**而红，
// 而行尾和被测的那件事毫无关系。
const sessionSrc = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'session', '[key].tsx'),
  'utf8',
).replace(/\r/g, '');

/**
 * owner 原话（第一次）：「不能切换模型，然后那个切换模型的位置是一个无意义的
 * 切换看多细节 改掉」——那颗药丸必须是**执行方式**，不是显示详略。
 *
 * owner 原话（第二次）：「harness 选择，模型选择，思考强度选择，权限选择，
 * 全部放到一个按钮里面」。所以现在是一颗 SetupPill 管四样，不再是一排。
 * 药丸行横向滚动，排第三之后的默认就在屏幕外——四颗并排等于把设置藏起来。
 */
test('输入框那颗药丸管的是执行方式，不是看多细', () => {
  // 不锁缩进：正则里写死空格数，格式化一下就红，那是把测试绑在排版上
  const pills = /pills=\{[\s\S]{0,600}?\n\s*\}\n/.exec(sessionSrc)?.[0] ?? '';
  expect(pills).toBeTruthy();
  expect(pills).toMatch(/SetupPill/);
  expect(pills).toMatch(/live\.model/);
  expect(pills).toMatch(/live\.effort/);
  expect(pills).not.toMatch(/VIEW_LABEL/);
});

test('详略三档没被删掉，只是挪进了右上角那张菜单', () => {
  // 「改掉」说的是那个位置，不是这个功能。砍掉它是超出授权的。
  // 2026-10-08 它从「更多」面板搬进了 SessionMenu（贴着按钮弹的那张卡片），
  // 名字也从「看多细 · Normal」改成了「详细程度 · 标准」。
  expect(sessionSrc).toMatch(/view=\{view\}/);
  expect(sessionSrc).toMatch(/onView=\{setView\}/);
  const menuSrc = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'SessionMenu.tsx'),
    'utf8',
  );
  expect(menuSrc).toMatch(/详细程度/);
  for (const v of ['summary', 'normal', 'verbose']) expect(menuSrc).toContain(v);
});

test('传完文件既不自动发送，也不动输入框里的字', () => {
  // owner 原话：「上传图片不要自动带上提示词」。
  // 上一版往草稿里塞「我传了一个文件到 …，你读一下」——那既替他决定了这一轮
  // 说什么，他想改写还得先绕开那句话。现在只往 attachments 里加一条，
  // 路径在发送那一刻才拼到正文末尾。
  //
  // 收文件的那一半现在叫 runUpload：拿文件有两条路（原生走选择器、网页走那个
  // 真 input），但「收下之后做什么」两条完全一样，所以合在了一处。
  const attach = /const runUpload = useCallback\(([\s\S]*?)\}, \[client, attaching\]\)/.exec(sessionSrc)?.[1] ?? '';
  expect(attach).toBeTruthy();
  expect(attach).toMatch(/setAttachments\(/);
  expect(attach).not.toMatch(/setDraft\(/);
  expect(attach).not.toMatch(/client\.send\(/);

  // 两条路都得经过它，不能有哪条绕过去自己收文件
  for (const via of ['pickAndUpload', 'uploadPicked']) {
    expect(sessionSrc).toMatch(new RegExp(`runUpload\\(\\(onPicking\\) => ${via}\\(`));
  }
});

test('附件路径在发送时才拼上——不给路径 agent 就看不见文件', () => {
  const send = /const send = useCallback\(([\s\S]*?)\}, \[draft, attachments/.exec(sessionSrc)?.[1] ?? '';
  expect(send).toBeTruthy();
  expect(send).toMatch(/attachmentSuffix\(attachments\)/);
  expect(send).toMatch(/setAttachments\(\[\]\)/); // 发完要清空，否则下一条会重复带上
});

const streamSrc = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'stream.tsx'),
  'utf8',
).replace(/\r/g, '');

test('agent 正文走 markdown 渲染，不是原样糊上去', () => {
  // owner 实测：手机上看到的是 **粗体**、## 标题 的原始格式。
  // agent 的回复几乎全是 markdown，不渲染等于把主要内容拿原文贴出来。
  expect(streamSrc).toMatch(/<Markdown text=\{text\}/);
  expect(streamSrc).not.toMatch(/function inlineCode/); // 旧的半吊子实现必须已删掉
});

const composerSrc = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'Composer.tsx'),
  'utf8',
).replace(/\r/g, '');

test('底部安全区用 max 不用加法', () => {
  // inset.bottom 本身就是避开 Home 指示条所需的余量，再加一个常数是重复计算——
  // 真机上会多出 44pt 空档，owner 反馈的「底部有很多空白」就是这个。
  expect(composerSrc).toMatch(/Math\.max\(\d+, inset\.bottom\)/);
  expect(composerSrc).not.toMatch(/\d+ \+ inset\.bottom/);
  expect(src).not.toMatch(/\d+ \+ inset\.bottom/);
});

/**
 * 以下三条原本在单独的 history.test.ts 里，它重新读了同样这三个源文件、
 * 用同样的源码 grep 写法，只是测试名换成了英文——两套一模一样的壳。
 * 并过来之后只剩一处维护。
 */
test('已归档的会话默认不出现在列表里', () => {
  expect(src).toMatch(/const \[showArchived, setShowArchived\] = useState\(false\)/);
  // 过滤本身在 api/groups.ts 里（分组那段 2026-10-08 挪出去了，那边有自己的单测）。
  // 只断言「过滤时用到了 showArchived 和 isArchived」，不锁死整个表达式——
  // 原来那条把变量名和写法全钉死了，改个中间变量名就会无故变红。
  const groupsSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'groups.ts'), 'utf8');
  expect(src).toMatch(/groupChains\([\s\S]{0,80}showArchived/);
  expect(groupsSrc).toMatch(/showArchived[\s\S]{0,120}isArchived/);
});

test('会话详情能往前翻历史，而且那个控件真的接上了 loadOlder', () => {
  // loadOlder 早就写好，但一直没有任何控件调用它——「往上还有更早的」只是一行字。
  expect(sessionSrc).toMatch(/live\.loadOlder\(\)/);
  expect(sessionSrc).toMatch(/live\.hasOlder/);
  expect(liveSrc).toMatch(/before: nextBefore/);
  expect(liveSrc).toMatch(/loadingOlder/);
});

test('首次进入会话落在最新一条，不是历史开头', () => {
  expect(sessionSrc).toMatch(/scrollToEnd\(\{ animated: false \}\)/);
  expect(sessionSrc).toMatch(/initialScrollDone/);
});

test('断流恢复不许只依赖平台事件', () => {
  // 初版只挂 AppState，实测不够：锁屏回来新回复就是不出现。
  // 判据必须是「多久没听到服务器」这个我们自己维护的事实。
  expect(liveSrc).toMatch(/const watchdog = setInterval/);
  expect(liveSrc).toMatch(/Date\.now\(\) - heard > STALE_AFTER_MS/);
  expect(liveSrc).toMatch(/clearInterval\(watchdog\)/);  // 卸载要清
});
