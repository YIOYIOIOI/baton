/**
 * Safari/PWA 会在**不重算**继承的 `100%` / `dvh` 高度链的情况下改变可视区，
 * 于是页面停在旧高度。这里给整个 app 维护一个明确的视口尺寸，
 * 键盘与浏览器工具栏的变化都在这一处消化，不靠各页面自己加偏移。
 */

/** 键盘大致会吃掉多少。小于这个量的缺口更像浏览器工具栏或启动瞬间没撑开。 */
const KEYBOARD_MIN_PX = 160;

/**
 * 按**当前方向**取屏幕的高度。
 *
 * `screen.height` 在 iOS 上不保证跟着方向变——横屏时它可能仍是竖屏那个值。
 * 直接拿它当"满屏高度"，横屏下会把 393pt 的可视区撑成 852pt，
 * 底部控件整个顶出屏幕。所以按可视区自己的长宽判断方向，
 * 再从 screen 的长短边里挑对应的那条。
 */
function fullScreenHeight(win: Window, visibleWidth: number, visibleHeight: number): number {
  const w = win.screen?.width;
  const h = win.screen?.height;
  if (!w || !h) return visibleHeight;
  const portrait = visibleWidth <= visibleHeight;
  return portrait ? Math.max(w, h) : Math.min(w, h);
}

/**
 * 独立 PWA 里，iOS 有时会把 Safari 工具栏那个**更小**的视口一并带进来、
 * 或者在启动那一刻还没把可视区撑开，而且自己不会修正。这两种都要补成满屏高，
 * 否则根容器停在矮尺寸上，**底部就空出一片**——这正是 owner 报的那个现象。
 *
 * 唯一不能补的是**键盘顶上来**的时候：那时小的才是对的。
 *
 * 判据必须同时看「有没有在输入」和「缺口有多大」，只看其中一个都会错：
 *   只看缺口大小    启动瞬间的缺口同样很大，会被误判成键盘，于是保留矮尺寸 → 底部空白
 *   只看有没有输入  光标留在输入框、键盘已经收起时，缺口很小，会被误判成键盘
 *
 * 方向问题由 fullScreenHeight 单独处理，不混在这条判断里。
 */
export function viewportHeight(win: Window, visibleHeight: number, visibleWidth?: number): number {
  const standalone = win.matchMedia?.('(display-mode: standalone)').matches
    || (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!standalone) return visibleHeight;

  const width = visibleWidth ?? win.innerWidth ?? visibleHeight;
  const full = fullScreenHeight(win, width, visibleHeight);

  const active = win.document.activeElement;
  const editing = !!active && (
    active.tagName === 'INPUT'
    || active.tagName === 'TEXTAREA'
    || active.getAttribute('contenteditable') === 'true'
    || active.getAttribute('contenteditable') === ''
  );
  const keyboardOpen = editing && full - visibleHeight > KEYBOARD_MIN_PX;
  return keyboardOpen ? visibleHeight : Math.max(visibleHeight, full);
}

export function attachBrowserViewport(win: Window): () => void {
  const style = win.document.documentElement.style;
  const viewport = win.visualViewport;
  const heightKey = '--baton-viewport-height';
  const topKey = '--baton-viewport-top';
  const previousHeight = style.getPropertyValue(heightKey);
  const previousTop = style.getPropertyValue(topKey);
  let frame: number | null = null;
  let disposed = false;

  const measure = () => {
    frame = null;
    if (disposed) return;
    // Pinch zoom must magnify the current layout, not resize/reflow the app.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const visibleHeight = viewport?.height ?? win.innerHeight;
    const visibleWidth = viewport?.width ?? win.innerWidth;
    const height = viewportHeight(win, visibleHeight, visibleWidth);
    const top = viewport?.offsetTop ?? 0;
    if (!Number.isFinite(height) || height <= 0) return;
    style.setProperty(heightKey, `${Math.round(height)}px`);
    style.setProperty(topKey, `${Math.max(0, Math.round(top))}px`);
  };

  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = win.requestAnimationFrame(measure);
  };

  measure();
  win.addEventListener('resize', schedule);
  win.addEventListener('orientationchange', schedule);
  win.addEventListener('pageshow', schedule);
  win.addEventListener('load', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);

  /**
   * 启动后再补量几次。
   *
   * iOS 把网页加到主屏、从图标启动时，**第一次测到的可视区常常是还没撑开的那个**，
   * 而且撑开之后不一定补发 resize。只靠事件的话根容器就停在矮尺寸上，
   * 底部空出一片——owner 报的正是这个。
   *
   * 所以不赌事件会来：启动后的一小段时间里按固定节奏各补一次。都是幂等的
   * （measure 只是写两个 CSS 变量），量到一样的值就什么都不会变。
   */
  const settleTimers = [120, 350, 800, 1500].map((ms) => win.setTimeout(schedule, ms));

  return () => {
    disposed = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    settleTimers.forEach((id) => win.clearTimeout(id));
    win.removeEventListener('resize', schedule);
    win.removeEventListener('orientationchange', schedule);
    win.removeEventListener('pageshow', schedule);
    win.removeEventListener('load', schedule);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    if (previousHeight) style.setProperty(heightKey, previousHeight);
    else style.removeProperty(heightKey);
    if (previousTop) style.setProperty(topKey, previousTop);
    else style.removeProperty(topKey);
  };
}
