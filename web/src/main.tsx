import { StrictMode, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './shared.css';
import { usePath, Link } from './router';
import { Welcome } from './Welcome';
import { Pair } from './Pair';
import { Shell } from './Shell';
import { Conversation } from './Conversation';
import { NewSession } from './NewSession';
import { About } from './About';
import { getBrowserLock, onBrowserLock, retryBrowserUnpair } from '../../app/src/store/browserSession';

/**
 * 路由。手写，没装 react-router——见 router.tsx 抬头。
 *
 * 服务端对找不到的无扩展名路径回退到 index.html（src/http/static.js 的 spa 分支），
 * 所以下面每条路径直接敲进地址栏都能进来。
 */
function Route() {
  const path = usePath();
  const lock = useSyncExternalStore(onBrowserLock, getBrowserLock);
  useEffect(() => {
    if (lock !== 'pending') return;
    const retry = () => { void retryBrowserUnpair(); };
    retry();
    const timer = setInterval(retry, 15_000);
    window.addEventListener('online', retry);
    return () => { clearInterval(timer); window.removeEventListener('online', retry); };
  }, [lock]);

  if (lock === 'pending' || (lock && path !== '/pair')) return <Welcome pending={lock === 'pending'} />;
  if (path === '/welcome') return <Welcome />;
  if (path === '/pair') return <Pair />;
  /*
    首页就是新建——Claude 的首页也是一个输入框（2026-11-06 起）。原来这里是「在跑 / 最近」
    两张表（Landing.tsx），那两样挪进了侧栏：「等你处理」一组与「按时间」视图。
    窄屏上 home 仍然先给列表，见 Shell 的 home 参数。
  */
  if (path === '/') {
    return (
      <Shell home>
        <NewSession />
      </Shell>
    );
  }
  if (path === '/new') {
    return (
      <Shell>
        <NewSession />
      </Shell>
    );
  }
  if (path === '/about') {
    return (
      <Shell>
        <About />
      </Shell>
    );
  }

  const session = /^\/session\/(.+)$/.exec(path);
  if (session) {
    const key = decodeURIComponent(session[1]);
    return (
      // key 传给 Shell 是为了高亮左边那一行；传给 Conversation 的 key={} 是为了
      // **切会话时整个重挂载**——不重挂载的话上一条会话的事件、滚动位置、
      // SSE 连接都会漏到下一条里。
      <Shell selectedKey={key}>
        <Conversation key={key} sessionKey={key} />
      </Shell>
    );
  }

  return <NotPorted path={path} />;
}

/**
 * 还没搬过来的页面。不做成 404：这条路由在 Expo 那套里是存在的，
 * 只是浏览器端还没实现。说清「是什么状态、该怎么办」比一句「页面不存在」有用。
 */
function NotPorted({ path }: { path: string }) {
  return (
    <main style={{ padding: '64px 24px', maxWidth: 520, margin: '0 auto' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0 }}>这一页还没搬过来</h1>
      <p style={{ color: 'var(--tx-secondary)', lineHeight: 1.6, marginTop: 12 }}>
        <code>{path}</code> 在浏览器端还没实现。
      </p>
      <p style={{ marginTop: 24 }}>
        <Link to="/" style={{ color: 'var(--accent)' }}>
          回到工作区
        </Link>
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Route />
  </StrictMode>,
);
