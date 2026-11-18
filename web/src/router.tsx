import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';

/**
 * 够用就好的路由。**没装 react-router**：现在只有四条路由、没有嵌套布局、
 * 没有 loader，装一个库是为将来付账，而将来长什么样还不知道。
 *
 * 为什么非要客户端路由：桌面上侧栏是常驻的，整页跳转会让它每次重建——
 * 滚动位置、展开的分组、过滤选择全丢。那不叫桌面应用。
 */

export function usePath(): string {
  const [path, setPath] = useState(() => normalize(window.location.pathname));

  useEffect(() => {
    // popstate 管浏览器的前进/后退；navigate 自己派发同名事件，
    // 因为 pushState **不会**触发 popstate（规范如此，不是浏览器的 bug）。
    const sync = () => setPath(normalize(window.location.pathname));
    window.addEventListener('popstate', sync);
    window.addEventListener('baton:navigate', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('baton:navigate', sync);
    };
  }, []);

  return path;
}

function normalize(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

export function navigate(to: string) {
  if (normalize(to) === normalize(window.location.pathname)) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('baton:navigate'));
}

/**
 * 站内链接。**仍然渲染真的 `<a href>`**——中键打开新标签页、右键复制链接、
 * 鼠标悬停显示地址，这些都是浏览器免费给的，换成 div+onClick 就全没了。
 * 只在「普通左键点击」时接管。
 */
export function Link({
  to,
  children,
  onClick: onClickProp,
  ...rest
}: { to: string; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  /*
    调用方自己的 onClick 先跑，然后才是这里的站内跳转——两个都要。

    2026-11-11 栽过：原来是 `onClick={onClick} {...rest}`，调用方一传 onClick（侧栏会话行要在点击时
    收起悬停卡片）就把这里的整个顶掉，点击变成浏览器原生跳转，切会话整页刷新（owner：「现在我切换
    聊天的时候会整个页面刷新」）。调用方在自己的 onClick 里 preventDefault 的话，这里照样让路。
  */
  const onClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onClickProp?.(e);
      // 带修饰键的点击是用户在要求新标签页/新窗口/下载，别抢
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      navigate(to);
    },
    [to, onClickProp],
  );

  return (
    <a href={to} {...rest} onClick={onClick}>
      {children}
    </a>
  );
}
