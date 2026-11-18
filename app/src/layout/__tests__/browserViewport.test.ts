import { attachBrowserViewport, viewportHeight } from '../browserViewport';

function makeBrowser({ height = 812, visual = true } = {}) {
  const values = new Map<string, string>();
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 0;
  const style = {
    getPropertyValue: (key: string) => values.get(key) ?? '',
    setProperty: (key: string, value: string) => { values.set(key, value); },
    removeProperty: (key: string) => { values.delete(key); },
  };
  const viewport = Object.assign(new EventTarget(), { height, offsetTop: 0, scale: 1 });
  const win = Object.assign(new EventTarget(), {
    innerHeight: height,
    document: { documentElement: { style }, activeElement: null },
    visualViewport: visual ? viewport : null,
    screen: { width: 402, height: 874 },
    navigator: {},
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    // 补量定时器：测试里不真的等，记下 id 好验证卸载时清掉了
    setTimeout: (fn: () => void, ms: number) => { timers.set(++nextId, { fn, ms }); return nextId; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  return { win, viewport, values, frames, timers, flush, window: win as unknown as Window };
}

const HEIGHT = '--baton-viewport-height';
const TOP = '--baton-viewport-top';

test('sets a definite visible height rather than inheriting a stale CSS height', () => {
  const b = makeBrowser({ height: 681 });
  const dispose = attachBrowserViewport(b.window);
  expect(b.values.get(HEIGHT)).toBe('681px');
  b.viewport.height = 874;
  b.viewport.dispatchEvent(new Event('resize'));
  b.flush();
  expect(b.values.get(HEIGHT)).toBe('874px');
  dispose();
});

test('keyboard open/close and viewport pan update without accumulating padding', () => {
  const b = makeBrowser({ height: 874 });
  const dispose = attachBrowserViewport(b.window);
  b.viewport.height = 530;
  b.viewport.offsetTop = 12;
  b.viewport.dispatchEvent(new Event('resize'));
  b.viewport.dispatchEvent(new Event('scroll'));
  expect(b.frames.size).toBe(1);
  b.flush();
  expect(b.values.get(HEIGHT)).toBe('530px');
  expect(b.values.get(TOP)).toBe('12px');
  b.viewport.height = 874;
  b.viewport.offsetTop = 0;
  b.viewport.dispatchEvent(new Event('resize'));
  b.flush();
  expect(b.values.get(HEIGHT)).toBe('874px');
  expect(b.values.get(TOP)).toBe('0px');
  dispose();
});

test.each(['resize', 'orientationchange', 'pageshow'])(
  'remeasures after %s, including restored PWA pages', (type) => {
    const b = makeBrowser({ visual: false });
    const dispose = attachBrowserViewport(b.window);
    b.win.innerHeight = 896;
    b.win.dispatchEvent(new Event(type));
    b.flush();
    expect(b.values.get(HEIGHT)).toBe('896px');
    dispose();
  },
);

test('pinch zoom does not reflow the app to the zoomed viewport size', () => {
  const b = makeBrowser();
  const dispose = attachBrowserViewport(b.window);
  b.viewport.height = 406;
  b.viewport.scale = 2;
  b.viewport.dispatchEvent(new Event('resize'));
  b.flush();
  expect(b.values.get(HEIGHT)).toBe('812px');
  dispose();
});

test('ignores zero-height transient measurements', () => {
  const b = makeBrowser();
  const dispose = attachBrowserViewport(b.window);
  b.viewport.height = 0;
  b.viewport.dispatchEvent(new Event('resize'));
  b.flush();
  expect(b.values.get(HEIGHT)).toBe('812px');
  dispose();
});

test('cleanup cancels pending work, removes listeners and restores existing variables', () => {
  const b = makeBrowser();
  b.values.set(HEIGHT, '100dvh');
  const dispose = attachBrowserViewport(b.window);
  b.win.dispatchEvent(new Event('resize'));
  dispose();
  expect(b.frames.size).toBe(0);
  expect(b.values.get(HEIGHT)).toBe('100dvh');
  expect(b.values.has(TOP)).toBe(false);
  b.viewport.dispatchEvent(new Event('resize'));
  b.win.dispatchEvent(new Event('pageshow'));
  expect(b.frames.size).toBe(0);
});

test('启动补量的定时器在卸载时要清掉，否则每次进出页面都堆一批', () => {
  const b = makeBrowser();
  const dispose = attachBrowserViewport(b.window);
  expect(b.timers.size).toBeGreaterThan(0);
  dispose();
  expect(b.timers.size).toBe(0);
});

test('启动补量确实会再量一次——iOS 撑开可视区后不一定补发事件', () => {
  const b = makeBrowser({ height: 520 });
  const dispose = attachBrowserViewport(b.window);
  expect(b.values.get(HEIGHT)).toBe('520px');
  // 事件一个都不发，只让补量定时器到点
  b.viewport.height = 874;
  [...b.timers.values()].forEach((t) => t.fn());
  b.flush();
  expect(b.values.get(HEIGHT)).toBe('874px');
  dispose();
});


/** 一台加到主屏的 iPhone：竖屏 402×874。 */
function standaloneBrowser({ w = 402, h = 874 } = {}) {
  const b = makeBrowser();
  b.win.screen = { width: w, height: h };
  b.win.matchMedia = () => ({ matches: true }) as MediaQueryList;
  return b;
}

/** 把焦点放进输入框，模拟键盘弹出。 */
function focusInput(b: ReturnType<typeof standaloneBrowser>) {
  Object.defineProperty(b.win.document, 'activeElement', {
    configurable: true, value: { tagName: 'TEXTAREA', getAttribute: () => null },
  });
}

test('uses the device screen height for standalone pages after Safari chrome disappears', () => {
  expect(viewportHeight(standaloneBrowser().window, 778, 402)).toBe(874);
});

test('PWA 启动瞬间可视区还没撑开时，补成满屏——否则底部空一片', () => {
  // owner 报的就是这个：加到主屏后打开，底部总是多出一块空白。
  // 这时**没有**任何输入框获得焦点，所以不能因为"缺口很大"就当成键盘。
  expect(viewportHeight(standaloneBrowser().window, 520, 402)).toBe(874);
});

test('keeps the smaller visible height when the standalone keyboard is open', () => {
  const b = standaloneBrowser();
  focusInput(b);
  expect(viewportHeight(b.window, 530, 402)).toBe(530);
});

test('光标还在输入框、但键盘已收起时不算键盘', () => {
  // 缺口只有 96（工具栏量级），这时该补成满屏，而不是保留矮尺寸
  const b = standaloneBrowser();
  focusInput(b);
  expect(viewportHeight(b.window, 778, 402)).toBe(874);
});

test('横屏下按方向取屏幕短边，不把可视区撑成竖屏屏高', () => {
  // iOS 的 screen.height 不保证跟着方向变。按 screen.height 直接 Math.max，
  // 393pt 的横屏可视区会被撑成 852pt，底部控件整个顶出屏幕。
  const b = standaloneBrowser({ w: 393, h: 852 });
  expect(viewportHeight(b.window, 393, 852)).toBe(393);
});

test('可视区比屏高还大时按可视区来', () => {
  expect(viewportHeight(standaloneBrowser().window, 900, 402)).toBe(900);
});

test('does not expand ordinary Safari pages under the browser toolbar', () => {
  const b = makeBrowser({ height: 778 });
  b.win.screen = { width: 402, height: 874 };
  expect(viewportHeight(b.window, 778, 402)).toBe(778);
});
