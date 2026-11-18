import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';
import { light, dark } from '@/theme/tokens';

/**
 * web 构建的根 HTML（只在 web 生效，原生端不走这里）。
 *
 * 三处必须自己写，Expo 的默认值在手机浏览器上都不对：
 *
 * 1. **`viewport-fit=cover`**。没有它，iPhone 上页面不会延伸到安全区底下，
 *    底部的输入区和 dock 会浮在一条白边上方，和原型对不上。
 * 2. **`color-scheme: light dark`**。声明了系统才会把原生控件（滚动条、
 *    输入框光标）跟着深色走；不声明的话深色页面上会冒出白色滚动条。
 * 3. 根容器必须使用确定的视口高度，不只是 min-height。运行时会以
 *    VisualViewport 的实际尺寸更新 CSS 变量，覆盖 iOS 恢复页面后的旧高度。
 *    安全区只由页面底部控件留一次，不在根容器重复扣除。
 */
/**
 * 图标的版本号。**换了图标就把它加一。**
 *
 * Safari 按域名长期缓存站点图标，而且和页面缓存是两套——重新构建、重新部署都
 * 不会让它去重取。加一之后 URL 变了，它才会当成新资源。
 *
 * 1 = 拱形 + 蓝球那版（在此之前是仿 Claude 的星星，owner 的手机上残留过）。
 */
const ICON_V = 1;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />
        <meta name="color-scheme" content="light dark" />
        {/* 加到主屏后按独立应用打开，且状态栏跟着页面走 */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Baton" />

        {/* 加到主屏后的图标。**Safari 只认 apple-touch-icon，不读 manifest 里的 icons**
            ——只写 manifest 的话 iOS 会去截一张页面缩略图当图标，那个很难看。

            `?v=` 是给**图标换代**用的：Safari 按域名长期缓存站点图标，换了图还会
            接着用旧的。改这个数字就等于换了个 URL，它才会去重取。
            owner 实测过这个坑：主屏图标已经是新的，分享面板里还是上一代那颗星星。 */}
        <link rel="apple-touch-icon" href={`/apple-touch-icon.png?v=${ICON_V}`} />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href={`/pwa-192.png?v=${ICON_V}`} type="image/png" />

        {/*
          分享出去时的预览。**不补这几行的话只能退到 favicon 兜底**——而 Safari 那份
          favicon 缓存正是最容易过期的东西，于是分享卡片上挂着上一代的图标。
          写明 og:image 就不用它猜了。

          `og:url` 故意不写：这几个 HTML 是静态导出的，同一份会在局域网地址、
          隧道域名、localhost 三种来源下发出去，写死任何一个都会是错的。
        */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Baton" />
        <meta property="og:title" content="Baton" />
        <meta property="og:description" content="在手机上接着电脑上的活" />
        <meta property="og:image" content={`/pwa-512.png?v=${ICON_V}`} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:image" content={`/pwa-512.png?v=${ICON_V}`} />
        {/* 标题不在这里写：Expo 的 head 管理器会在最前面放一个占位 <title>，
            浏览器用的是第一个，硬塞在这儿的那个永远赢不了。由 _layout 里的
            <Head> 去填那个占位。 */}

        {/* RN Web 的 ScrollView 在 web 上需要这段重置，Expo 官方要求放在这里 */}
        <ScrollViewStyleReset />

        <style dangerouslySetInnerHTML={{ __html: BODY_BG }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

// 静态 HTML 提供首帧兜底；_layout 按实际 React 主题和可视区域同步变量。
// 不能只把漏出的背景染深：min-height 不会修正已经停在旧高度的页面。
const BODY_BG = `
:root { --baton-page-background: ${light.bgTertiary}; }
@media (prefers-color-scheme: dark) {
  :root { --baton-page-background: ${dark.bgTertiary}; }
}
html, body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background-color: var(--baton-page-background);
}
html { height: var(--baton-viewport-height, 100dvh); }
/* 「减弱动效」：网页上的 CSS 过渡（按下反馈那条，见 ui.tsx 的 WEB_PRESS）一并压成 0。
   RN 的 Animated 不走这里，那些在组件里各自读 useReduceMotion。 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0s !important; }
}
#root {
  display: flex;
  flex-direction: column;
  position: fixed;
  top: var(--baton-viewport-top, 0px);
  left: 0;
  width: 100%;
  height: 100%;
  height: var(--baton-viewport-height, 100dvh);
  min-height: 0;
  overflow: hidden;
  background-color: var(--baton-page-background);
}
`;
