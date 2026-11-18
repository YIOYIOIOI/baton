import fs from 'node:fs';
import path from 'node:path';

/**
 * 网页端必须**自己订阅**系统深浅色。
 *
 * RN Web 的 `useColorScheme()` 读得到值，但**不会因为值变了就通知组件重渲染**。
 * 后果比「切换系统外观时不跟」更糟：静态导出的首屏在 Node 里预渲染，那时没有
 * matchMedia，只能按浅色出；水合之后没人叫醒，于是**任何不因为别的原因重渲染
 * 的组件就永远停在浅色**。
 *
 * 浏览器里量到的（生产导出、深色系统、全新加载）：
 *   页底 rgb(23,23,26) 深、屏幕内的筛选栏 rgb(242,240,234) 深，
 *   而底部 dock 是 rgb(34,33,31) 浅 —— 一整块浅色压在近黑的页面上。
 * 两处是**同一个 Segmented**，只是前者因为会话列表加载重渲染过、后者没有。
 *
 * 这条第一次查的时候误判成「没问题」：当时用浏览器的 colorScheme 模拟去翻，
 * 而那套模拟只改 matchMedia 的 matches、**不发 change 事件**，任何订阅都不可能
 * 被触发。真正把病因钉死的是上面那对同组件不同色的对照。
 *
 * 所以这条不能只靠注释守：改回单独一个 useColorScheme() 会**静默**退化——
 * 不报错、不失败，只是深色模式下 dock 变成一块浅色板。
 */
const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

test('web 走自己订阅的 matchMedia，不是 useColorScheme', () => {
  expect(src).toMatch(/useSyncExternalStore\(subscribeWeb, webDark, webDarkOnServer\)/);
  expect(src).toMatch(/mq\.addEventListener\('change', onChange\)/);
  // 订阅了就得退订，否则每个用 useTheme 的组件卸载都漏一个监听器
  expect(src).toMatch(/mq\.removeEventListener\('change', onChange\)/);
});

test('原生仍然走 useColorScheme——那条是好用的，别一起换掉', () => {
  expect(src).toMatch(/const nativeDark = useColorScheme\(\) === 'dark'/);
  expect(src).toMatch(/Platform\.OS === 'web' \? web : nativeDark/);
});

test('预渲染按浅色出，避免浅色用户闪一帧深色', () => {
  // 服务端没有 matchMedia。这里若返回 true，水合后会从深色跳回浅色
  expect(src).toMatch(/const webDarkOnServer = \(\) => false/);
});

test('两个钩子都无条件调用，不许塞进平台分支里', () => {
  // hooks 规则：按平台 if 一下，切换时就会崩。判断只能落在取值那一步。
  expect(src).not.toMatch(/if \(Platform\.OS === 'web'\)[\s\S]{0,80}use[A-Z]/);
});
