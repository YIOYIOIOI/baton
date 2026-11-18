import { classifyProbe, isStopwatchStale, STALE_AFTER_MS } from '../classify';

/**
 * 五种失败在用户眼里长得很像，但该做的事完全不同。判错会把人引向错误的动作，
 * 所以这里每一条都钉死一个判据。
 */

const probe = (status: number, headers: Record<string, string> = {}, type?: string) => ({
  status,
  header: (n: string) => headers[n.toLowerCase()] ?? null,
  type,
});

test('fetch 抛异常 = 一个字节都没出去 = 手机没网', () => {
  expect(classifyProbe({ networkError: true })).toBe('offline');
});

test('带 X-Baton 的响应就是 Baton 在说话，连接是通的', () => {
  expect(classifyProbe(probe(200, { 'x-baton': '1' }))).toBe('ok');
});

test('401 带 X-Baton 仍判 ok——那是「没配对」，不是传输问题', () => {
  // 两件事混在一起的话，「重新配对」和「等网络」会互相盖住
  expect(classifyProbe(probe(401, { 'x-baton': '1' }))).toBe('ok');
});

test('CF 的 502/521-524/530 且带 cf-ray = 源站不应答（电脑睡了）', () => {
  for (const s of [502, 521, 522, 523, 524, 530]) {
    expect(classifyProbe(probe(s, { 'cf-ray': 'abc' }))).toBe('origin');
  }
});

test('同样的状态码但没有 cf-ray，就不能断言是 Cloudflare 替源站回的', () => {
  expect(classifyProbe(probe(502, {}))).toBe('intercepted');
});

test('200 但没有 X-Baton = 强制门户在回话', () => {
  // 公司网的登录页就是这样：拿任意 HTML 回 200
  expect(classifyProbe(probe(200, {}))).toBe('intercepted');
});

test('3xx 与不透明重定向都判为被拦截', () => {
  expect(classifyProbe(probe(302, {}))).toBe('intercepted');
  expect(classifyProbe(probe(0, {}, 'opaqueredirect'))).toBe('intercepted');
});

test('说不准是谁回的就按暂时故障重试，不猜', () => {
  // 猜错会把用户引向错误的动作，代价比「多等一下」大
  expect(classifyProbe(probe(418, {}))).toBe('retrying');
});

test('秒表活性阈值是两个心跳周期，不是一个', () => {
  // 一个周期太敏感：一次 GC 或一次移动网络切换就会误报「连接已死」。
  // 误报比晚报更糟——它会让用户不敢相信这个指示器。
  const t0 = 1_000_000;
  expect(isStopwatchStale(t0, t0 + 15_000)).toBe(false);
  expect(isStopwatchStale(t0, t0 + STALE_AFTER_MS - 1)).toBe(false);
  expect(isStopwatchStale(t0, t0 + STALE_AFTER_MS + 1)).toBe(true);
});
