import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 「粘在底部」。
 *
 * 判据抄自 assistant-ui 的 `packages/store/src/utils/viewport-scroll.ts`
 * 与 `useThreadViewportAutoScroll.ts`——这几条看着琐碎，但自己写几乎必错：
 *
 * 1. **判断「用户主动上滚」必须同时比较 scrollHeight。**
 *    只看 scrollTop 变小的话，往上翻历史时前插内容、或流式输出撑高容器，
 *    都会被误判成"用户想离开底部"，于是自动跟随被莫名其妙地关掉。
 *
 * 2. **平滑滚动途中要忽略中间态。** 一次 smooth 滚动会连发几十个 scroll 事件，
 *    不挡住的话 isAtBottom 会闪烁、跟随意图被自己的动画清掉。
 *
 * 3. **内容没撑满时 isAtBottom 是"假的"**（scrollHeight <= clientHeight 恒等于
 *    在底部），此时不该据此做判断。
 *
 * 4. **ResizeObserver 不够，要配 MutationObserver。** 流式文字变长时容器盒子
 *    未必变化，ResizeObserver 不触发；而纯 style 属性变更要过滤掉，否则
 *    自己写样式会引发回环。
 */

type Metrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

const atBottom = (m: Metrics) =>
  Math.abs(m.scrollHeight - m.scrollTop - m.clientHeight) <= 1 ||
  m.scrollHeight <= m.clientHeight;

const overflows = (m: Metrics) => m.scrollHeight > m.clientHeight + 1;

/** scrollHeight 相等才算数——否则内容驱动的位移会被读成用户上滚。 */
const userScrolledUp = (prev: { scrollTop: number; scrollHeight: number }, now: Metrics) =>
  prev.scrollTop > now.scrollTop && prev.scrollHeight === now.scrollHeight;

function observeContent(el: HTMLElement, cb: () => void): () => void {
  const off: (() => void)[] = [];
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(cb);
    ro.observe(el);
    off.push(() => ro.disconnect());
  }
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver((records) => {
      // 只有 style 属性变了的话忽略：写样式的代码路径自己会触发它，形成回环
      if (records.some((r) => r.type !== 'attributes' || r.attributeName !== 'style')) cb();
    });
    mo.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
    off.push(() => mo.disconnect());
  }
  return () => off.forEach((f) => f());
}

export function useStickToBottom<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const follow = useRef(true);
  const smoothing = useRef(false);
  const last = useRef({ scrollTop: 0, scrollHeight: 0 });
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = ref.current;
    if (!el) return;
    follow.current = true;
    smoothing.current = behavior === 'smooth';
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  /**
   * 跳到某个位置，并且**不再跟随**。从缓存回到一个会话、上次停在历史中间时用（Conversation.tsx）。
   *
   * 不能直接改 scrollTop：跟随只在「往上滚」时才关（userScrolledUp 拿上一次的位置比），
   * 而从 0 跳到中间看起来是在往下滚——跟随还开着，内容一排完版就被拽回最底下（实测）。
   */
  const restoreTo = useCallback((top: number) => {
    const el = ref.current;
    if (!el) return;
    follow.current = false;
    smoothing.current = false;
    el.scrollTop = top;
    const m: Metrics = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    last.current = { scrollTop: m.scrollTop, scrollHeight: m.scrollHeight };
    setShowJump(!atBottom(m) && overflows(m));
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const m: Metrics = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
    const now = atBottom(m);

    // 平滑滚动落地前的中间帧：不动任何状态，否则自己的动画会把意图清掉
    const inFlight = smoothing.current && !now && last.current.scrollTop < m.scrollTop;
    if (!inFlight) {
      if (now) {
        if (overflows(m)) smoothing.current = false;
        follow.current = true;
      } else if (userScrolledUp(last.current, m)) {
        smoothing.current = false;
        follow.current = false;
      }
      setShowJump(!now && overflows(m));
    }

    last.current = { scrollTop: m.scrollTop, scrollHeight: m.scrollHeight };
  }, []);

  // 内容变化时，只有还在跟随才贴底。否则会把正在读历史的人硬拽到最新处。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeContent(el, () => {
      if (follow.current) {
        el.scrollTop = el.scrollHeight;
        last.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
      } else {
        onScroll();
      }
    });
  }, [onScroll]);

  return { ref, onScroll, scrollToBottom, restoreTo, showJump, isFollowing: follow };
}
