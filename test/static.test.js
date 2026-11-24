import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStatic, mimeOf, cacheOf, isMobileUA, pickWebRoot } from '../src/http/static.js';
import { tmpDir } from './helpers.js';

/**
 * 静态服务的唯一安全面是**路径穿越**：URL 里的路径直接参与拼磁盘路径，
 * 拼错一次就能把 ~/.baton/token 读出去。这一组把每种穿越写法都试一遍。
 */

function siteWithSecret() {
  const outer = fs.realpathSync(tmpDir());
  const root = path.join(outer, 'site');
  fs.mkdirSync(path.join(root, 'session'), { recursive: true });
  fs.mkdirSync(path.join(root, '_expo', 'static'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>list</h1>');
  fs.writeFileSync(path.join(root, 'pair.html'), '<h1>pair</h1>');
  fs.writeFileSync(path.join(root, 'session', '[key].html'), '<h1>session</h1>');
  fs.writeFileSync(path.join(root, '_expo', 'static', 'entry-0123456789abcdef0.js'), 'x');
  // root 之外放一个"机密"，每条穿越用例都要拿不到它
  fs.writeFileSync(path.join(outer, 'SECRET.txt'), 'token');
  return root;
}

test('根路径给 index.html', () => {
  const root = siteWithSecret();
  assert.equal(resolveStatic(root, '/'), path.resolve(root, 'index.html'));
});

test('无扩展名的路由落到同名 .html', () => {
  const root = siteWithSecret();
  assert.equal(resolveStatic(root, '/pair'), path.resolve(root, 'pair.html'));
});

test('动态段落到 [key].html——/session/<任意 key> 都要能开', () => {
  const root = siteWithSecret();
  const want = path.resolve(root, 'session', '[key].html');
  assert.equal(resolveStatic(root, '/session/claude:Qy0teWFv'), want);
  // 冒号、连字符、下划线都要原样放行——会话 key 是 `claude:<base64url>`
  assert.equal(resolveStatic(root, '/session/codex:aB-_9x'), want);

  // 解码后带路径分隔符的一律拒绝，**不当成一段路径**。真实 key 是 base64url，
  // 永远不含 `/`，所以拒绝它不会误伤；而把它当分隔符就等于给了穿越一条路。
  assert.equal(resolveStatic(root, `/session/${encodeURIComponent('a/b')}`), null);
});

test('真实存在的文件按原样给', () => {
  const root = siteWithSecret();
  assert.equal(
    resolveStatic(root, '/_expo/static/entry-0123456789abcdef0.js'),
    path.resolve(root, '_expo', 'static', 'entry-0123456789abcdef0.js'),
  );
});

test('公开资源解析排除上传目录及指向其内容的目录别名', () => {
  const root = siteWithSecret();
  const uploads = path.join(root, '.baton-uploads');
  fs.mkdirSync(uploads);
  fs.writeFileSync(path.join(uploads, 'sample.txt'), 'fixture');
  fs.symlinkSync(uploads, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveStatic(root, '/.baton-uploads/sample.txt'), null);
  assert.equal(resolveStatic(root, '/alias/sample.txt'), null);
  assert.equal(resolveStatic(root, '/%2ebaton-uploads/missing', { spa: true }), null);
  assert.equal(resolveStatic(root, '/ordinary-route', { spa: true }), path.join(root, 'index.html'));
});

// ── 路径穿越 ────────────────────────────────────

test('各种穿越写法都拿不到 root 之外的文件', () => {
  const root = siteWithSecret();
  const attempts = [
    '/../SECRET.txt',
    '/./../SECRET.txt',
    '/session/../../SECRET.txt',
    '/%2e%2e/SECRET.txt',              // 编码过的 ..
    '/%2e%2e%2fSECRET.txt',            // 编码过的 ../
    '/..%2fSECRET.txt',
    '/session/%2e%2e%2f%2e%2e%2fSECRET.txt',
    '/....//SECRET.txt',
    '/%00/SECRET.txt',                 // 空字节截断
  ];
  for (const a of attempts) {
    const got = resolveStatic(root, a);
    assert.ok(
      got === null || got.startsWith(path.resolve(root) + path.sep),
      `${a} 逃出了 root：${got}`,
    );
    assert.ok(!String(got).includes('SECRET'), `${a} 读到了 root 之外的文件`);
  }
});

test('反斜杠不能当分隔符用（Windows 上尤其要命）', () => {
  const root = siteWithSecret();
  assert.equal(resolveStatic(root, '/..\\SECRET.txt'), null);
  assert.equal(resolveStatic(root, '/%5c..%5cSECRET.txt'), null);
});

test('不存在的路径返回 null，不要回退到 index.html', () => {
  // 回退会让所有打错的 API 路径都拿到一个 200 的 HTML，
  // 客户端拿到 200 却解析不出 JSON，错得莫名其妙
  const root = siteWithSecret();
  assert.equal(resolveStatic(root, '/nope'), null);
  assert.equal(resolveStatic(root, '/a/b/c/d'), null);
});

// ── 头 ──────────────────────────────────────────

test('MIME 按扩展名给', () => {
  assert.match(mimeOf('a.html'), /text\/html/);
  assert.match(mimeOf('a.js'), /javascript/);
  assert.match(mimeOf('a.css'), /text\/css/);
  assert.equal(mimeOf('a.unknown'), 'application/octet-stream');
});

test('HTML 绝不缓存，带内容哈希的资源长缓存', () => {
  // 发了新版本而 HTML 被缓存 = 旧壳子配新 bundle，那种半新半旧最难查
  assert.equal(cacheOf('/x/index.html'), 'no-cache');
  assert.match(cacheOf('/x/entry-0123456789abcdef0.js'), /immutable/);
  assert.equal(cacheOf('/x/plain.js'), 'no-cache');
});

test('符号链接指向 root 之外时也要拒绝（逐段检查看不见这种）', (t) => {
  // 这是第二道闸唯一防得住而第一道防不住的情况：每一段都合法，
  // 但拼出来的路径经由链接落到了 root 外面。
  const root = siteWithSecret();
  const outside = path.join(root, '..', 'outside-dir');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'leak.html'), 'secret');

  try {
    // Windows 上 junction 不需要管理员权限
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  } catch {
    t.skip('本机不允许创建链接，跳过');
    return;
  }

  const got = resolveStatic(root, '/link/leak.html');
  assert.equal(got, null, '经由链接逃出 root 的路径必须被拒绝');
});

// ── 按设备分流 ──────────────────────────────────

/**
 * 电脑走 web/（为宽屏写的 DOM 版），手机走 app/（为触摸写的那套）。
 *
 * **User-Agent 嗅探不可靠**，这一点写在 isMobileUA 的注释里：iPad 自称是 Mac，
 * 「请求桌面版网站」会把判断翻过来。所以它只是个默认值，两套 UI 都得能在
 * 另一种屏幕上活下去。这里钉的是「默认值别挑错」，不是「判断永远对」。
 */
test('手机 UA 能认出来', () => {
  for (const ua of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    'Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
  ]) assert.equal(isMobileUA(ua), true, ua.slice(0, 40));
});

test('电脑 UA 不该被当成手机', () => {
  for (const ua of [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    '',
    undefined,
  ]) assert.equal(isMobileUA(ua), false, String(ua).slice(0, 40));
});

/**
 * **只有一套构建时不分流。**
 *
 * 没得选的时候把手机挡在门外，比给它一个不完美的界面糟得多——而这正是
 * 「分流」最容易写错的地方：分支写顺手了，就会在另一套不存在时返回 404。
 */
test('只有一套构建时两种设备拿到同一套', () => {
  // 真实文件系统上现在只有 app/dist（web/dist 没构建），所以两边应当一致
  const desktop = pickWebRoot({ mobile: false });
  const phone = pickWebRoot({ mobile: true });
  if (desktop.kind === 'spa' && phone.kind === 'expo') return; // 两套都在，另一条测试管
  assert.equal(desktop.kind, phone.kind, '只有一套时不该分流');
});
