import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { canonicalPath, under, UPLOAD_DIR } from '../scope.js';

/**
 * 静态资源服务。
 *
 * 三套客户端：
 *   web/dist/   Vite + React。为宽屏写的 DOM 版，**电脑浏览器**走它
 *   app/dist/   Expo 的 web 导出。为触摸写的那版，**手机/平板浏览器**走它
 *               （朋友那台安卓平板就是这一套——它不是历史产物）
 *   src/web/    v1 的原生 JS 页面，没有构建步骤，两份 dist 都不在时兜底
 *
 * 怎么选见下面的 pickWebRoot：两份都在就按 UA 分流，只有一份就谁都给它。
 * 同一个浏览器在一次会话里只会拿到其中一套——同一个 URL 上摆两个界面
 * 只会让人搞不清自己在看哪个。
 *
 * 两份 dist 都要先构建才有，所以新克隆的仓库默认跑 v1 那套：
 * 后端「零依赖、零构建」这条性质没有因为客户端而丢掉。
 *
 * 为什么浏览器端从 Expo 里分出来：见
 * docs/superpowers/specs/2026-09-14-baton-desktop-web-design.md §2。
 * 一句话——技术上 RN Web 做得了桌面（Happy / Bluesky 都在这么出货），
 * 但那些项目是一个团队在定全仓约定；这里 iOS 与 Web 由不同的人并行推进，
 * 共用组件树会让双方各自立的不变量互相打架。
 */

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const LEGACY_DIR = path.join(HERE, '..', 'web');
export const EXPO_DIR = path.join(HERE, '..', '..', 'app', 'dist');
export const SPA_DIR = path.join(HERE, '..', '..', 'web', 'dist');

/** 三套可发布的资源树都保留给客户端，包括暂未被当前 UA 选中的构建。 */
export function inWebRoot(realTarget, roots = [LEGACY_DIR, EXPO_DIR, SPA_DIR]) {
  return roots.some((root) => under(realTarget, root) || under(realTarget, canonicalPath(root)));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  // 这几种原来缺：上传回读按类型决定能不能在页面里直接显示，缺了就会被当成下载
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * 是不是手机/平板在访问。
 *
 * **User-Agent 嗅探不可靠，这一点必须先说清楚**：iPad 默认自称是 Mac；任何
 * 浏览器的「请求桌面版网站」都会把它翻过来。所以这只是一个**默认值**，
 * 不是判据——两套 UI 都必须自己能在另一种屏幕上活下去，不能靠这个兜底。
 *
 * 判据取 `Mobile` 这个标记而不是列设备名单：iOS/Android 的浏览器 UA 里都带它，
 * 而设备名单永远落后于新机型。`Mobi` 是 Firefox 的写法。
 */
export function isMobileUA(ua) {
  return /Android|iPhone|iPod|Mobi(le)?\b/i.test(String(ua ?? ''));
}

/**
 * 哪套客户端在生效。启动横幅要告诉 owner，否则他分不清手机上看到的是哪个界面。
 *
 * 两套构建都在时按设备分流：**电脑走 web/（为宽屏写的 DOM 版），手机走 app/
 * （为触摸写的那版）**。只有一套时不分流——因为没得选，这时候把手机挡在门外
 * 比给它一个不完美的界面糟得多。
 *
 * 资源路径不会串：Expo 导出走 `/_expo/`，Vite 走 `/assets/`，各取各的。
 * 同一个浏览器的 UA 在一次会话里是稳定的，所以 HTML 和它的资源来自同一套。
 */
export function pickWebRoot({ mobile = false } = {}) {
  const spa = isFile(path.join(SPA_DIR, 'index.html'));
  const expo = isFile(path.join(EXPO_DIR, 'index.html'));
  if (spa && expo) {
    return mobile ? { dir: EXPO_DIR, kind: 'expo' } : { dir: SPA_DIR, kind: 'spa' };
  }
  if (spa) return { dir: SPA_DIR, kind: 'spa' };
  if (expo) return { dir: EXPO_DIR, kind: 'expo' };
  return { dir: LEGACY_DIR, kind: 'legacy' };
}

/** 启动横幅与报错里用的人话目录名。 */
export function webRootLabel(kind) {
  if (kind === 'spa') return 'web/dist/';
  if (kind === 'expo') return 'app/dist/';
  return 'src/web/';
}

/** 目录里的 `[param].html` / `[param]` —— Expo 导出的动态路由就长这样。 */
function findDynamic(dir, suffix) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.startsWith('[') && n.endsWith(suffix === '' ? ']' : `]${suffix}`));
  return hit ? path.join(dir, hit) : null;
}

/**
 * URL 路径 → 磁盘文件。
 *
 * **路径穿越是这里唯一的安全面**，两道闸：
 *   1. 逐段检查，任何一段是 `.`、`..`，或解码后还带分隔符，一律拒绝；
 *   2. 最后再 resolve 一次，确认结果仍在 root 之内——防的是符号链接一类
 *      逐段检查看不出来的情况。
 */
function staticSegments(pathname) {
  const raw = pathname.split('/').filter(Boolean);
  const segs = [];
  for (const s of raw) {
    let d;
    try {
      d = decodeURIComponent(s);
    } catch {
      return null; // 坏编码
    }
    if (d === '.' || d === '..' || d.includes('/') || d.includes('\\') || d.includes('\0') || isUploadSegment(d)) return null;
    segs.push(d);
  }

  return segs;
}

function isUploadSegment(name) {
  return name.toLowerCase() === UPLOAD_DIR;
}

function resolveExact(root, segs) {
  let hit = null;
  if (segs.length === 0) {
    hit = path.join(root, 'index.html');
  } else {
    let dir = root;
    for (let i = 0; i < segs.length; i += 1) {
      const literal = path.join(dir, segs[i]);
      const last = i === segs.length - 1;

      if (last) {
        if (isFile(literal)) { hit = literal; break; }
        if (isFile(`${literal}.html`)) { hit = `${literal}.html`; break; }
        if (isFile(path.join(literal, 'index.html'))) { hit = path.join(literal, 'index.html'); break; }
        // 动态段：/session/<任意 key> → session/[key].html
        hit = findDynamic(dir, '.html');
        break;
      }

      if (isDir(literal)) { dir = literal; continue; }
      const dynDir = findDynamic(dir, '');
      if (dynDir && isDir(dynDir)) { dir = dynDir; continue; }
      return null;
    }
  }

  if (!hit || !isFile(hit)) return null;

  // 第二道闸：算完之后必须仍在 root 里。
  //
  // 必须用 realpathSync 而不是 path.resolve——**后者不解析符号链接**，
  // 于是 root 里一个指向外面的链接能让 `root/link/leak.html` 在字面上
  // 完全合法地通过检查。这条是写完测试才发现的：初版用 path.resolve，
  // 注释写着「防符号链接」，实际一点都不防。
  let abs;
  let base;
  try {
    abs = fs.realpathSync.native(hit);
    base = fs.realpathSync.native(root);
  } catch {
    return null;
  }
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/**
 * URL 路径 → 磁盘文件，带 SPA 回退。
 *
 * `web/dist` 那套是单页应用：路由在客户端，磁盘上只有一个 index.html。
 * 所以 /welcome、/session/xxx 这类路径落不到文件上，必须回退到 index.html
 * 由前端自己分发；Expo 与 legacy 那两套是每条路由一个 .html，不需要回退。
 *
 * **带扩展名的一律不回退。** /assets/foo.js 找不到就该是 404——
 * 回退成 index.html 会让浏览器把一段 HTML 当作 JS 去解析，
 * 报出来的错和真正的原因（文件没构建出来）毫无关系，极难查。
 *
 * 回退本身也走 resolveExact，因此路径穿越的两道闸一个不少。
 */
export function resolveStatic(root, pathname, { spa = false } = {}) {
  const segs = staticSegments(pathname);
  if (!segs) return null;
  const hit = resolveExact(root, segs) ?? (spa && !path.extname(pathname) ? resolveExact(root, []) : null);
  return hit && !hit.split(path.sep).some(isUploadSegment) ? hit : null;
}

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 缓存策略。
 * 带内容哈希的资源可以长缓存（改了内容就换文件名）；HTML 绝不缓存，
 * 否则发了新版本，手机上还是旧壳子配新 bundle——那种半新半旧最难查。
 */
export function cacheOf(file) {
  if (/\.html$/i.test(file)) return 'no-cache';
  if (/-[0-9a-f]{16,}\./i.test(path.basename(file))) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}
