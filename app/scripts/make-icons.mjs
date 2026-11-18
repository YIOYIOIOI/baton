import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { PNG } from 'pngjs';

/**
 * 从方案给的 1024 图标派生出各尺寸。
 *
 * **上一版是手写 PNG 画一个珊瑚色 spike**——那是旧视觉方案，整套已经作废。
 * 现在的图标是方案交付的位图（两只手递一个蓝球），所以这里的活从「画」变成了
 * 「缩」。源图一个像素都不改：颜色、构图、留白都是方案定的。
 *
 * 缩放用**盒式滤波**（把源区域内所有像素求平均），不是最近邻：
 * 1024 → 32 是 32 倍降采样，最近邻会把细线（那几道放射短划）随机采没或采成锯齿。
 *
 * 依赖 pngjs。它不是本项目的直接依赖，是 expo 工具链带进来的——
 * 这个脚本只在改图标时手动跑一次，产物进 git，所以运行期不依赖它。
 * 真哪天 pngjs 没了，重装 node_modules 或换个解码器即可，不影响 app 构建。
 */

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'assets', 'images');

// owner 从四个候选里点名要左上那个（拱形 + 蓝球，抽象的 b）。
// baton-mark-1024.png 是从那张四宫格里按实测包围盒（x 115–442, y 76–473）裁出来、
// 居中放在方案底色上得到的；设计包自带的 baton-app-icon-1024.png（两只手）是另一版，
// 留在 .design 里备查，不再用作图标。
const SRC = path.join(HERE, '..', '..', '.design', 'baton-mark-1024.png');

const BG = [0xf5, 0xf2, 0xeb]; // 方案底色 #F5F2EB

/** 盒式降采样。src 为 RGBA，输出同样 RGBA。 */
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * yr);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yr));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * xr);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xr));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = y0; sy < y1 && sy < sh; sy += 1) {
        for (let sx = x0; sx < x1 && sx < sw; sx += 1) {
          const i = (sy * sw + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
          n += 1;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/**
 * 把半透明像素压到不透明底色上。
 *
 * iOS 的 app 图标**不能带 alpha**——带了会被拒或渲染出黑边，圆角由系统切。
 * 所以凡是要当 app 图标用的尺寸，都先合成到底色上。
 */
function flatten(rgba, w, h, bg) {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    const a = rgba[o + 3] / 255;
    out[o] = Math.round(rgba[o] * a + bg[0] * (1 - a));
    out[o + 1] = Math.round(rgba[o + 1] * a + bg[1] * (1 - a));
    out[o + 2] = Math.round(rgba[o + 2] * a + bg[2] * (1 - a));
    out[o + 3] = 255;
  }
  return out;
}

// PWA 那几张必须同时落到 public/：Expo 把 public/ 原样拷进 dist，
// 而 manifest.json 里写的是 /pwa-192.png 这种根路径。只写 assets/images
// 的话，构建产物里留的还是上一版图标——这一步漏过一次。
const PUBLIC = path.join(HERE, '..', 'public');
const ALSO_PUBLIC = new Set(['pwa-192.png', 'pwa-512.png', 'apple-touch-icon.png']);

/**
 * 把底色像素挖成透明。
 *
 * 源图的底色是烤进去的（它就是一张方形图标）。但 Android 自适应图标的前景层
 * 和启动屏的图片都必须透明——不透明的话，前景会变成一个 66% 大小的实心方块
 * 盖在背景层上，各家厂商的圆形/水滴形裁切就全露馅了。
 */
function knockout(rgba, w, h, bg, tol = 14) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    const dist = Math.abs(out[o] - bg[0]) + Math.abs(out[o + 1] - bg[1]) + Math.abs(out[o + 2] - bg[2]);
    if (dist <= tol) out[o + 3] = 0;
  }
  return out;
}

function write(file, rgba, w, h) {
  const png = new PNG({ width: w, height: h });
  rgba.copy(png.data);
  const buf = PNG.sync.write(png);
  fs.writeFileSync(path.join(OUT, file), buf);
  let where = '';
  if (ALSO_PUBLIC.has(file)) {
    fs.mkdirSync(PUBLIC, { recursive: true });
    fs.writeFileSync(path.join(PUBLIC, file), buf);
    where = ' + public/';
  }
  console.log(`  ${file.padEnd(30)} ${w}×${h}  ${(buf.length / 1024).toFixed(1)} KB${where}`);
}

const src = PNG.sync.read(fs.readFileSync(SRC));
console.log(`源图 ${src.width}×${src.height}`);

// 各尺寸的用途——不是随便挑的：
//   1024  App Store / Expo 主图标
//    512  PWA 大图标（安装到主屏时的高清源）
//    192  PWA 标准图标
//    180  iOS apple-touch-icon（加到主屏的那个）
//     32  浏览器标签页 favicon
const SIZES = [
  ['icon.png', 1024],
  ['pwa-512.png', 512],
  ['pwa-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['favicon.png', 32],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [file, n] of SIZES) {
  const scaled = n === src.width ? Buffer.from(src.data) : resize(src.data, src.width, src.height, n, n);
  write(file, flatten(scaled, n, n, BG), n, n);
}

// 启动屏的图要透明：Expo 把它摆在 backgroundColor 上，自带底色会露出一个方块边
{
  const n = 512;
  const scaled = resize(src.data, src.width, src.height, n, n);
  write('splash-icon.png', knockout(scaled, n, n, BG), n, n);
}

// Android 自适应图标：前景要留 safe zone（系统会按各家形状裁切，
// 最坏情况只保证中间 66% 可见），所以前景缩到 66% 居中，四周透明。
// 背景是纯色一张，颜色与图标底色一致，接缝才看不出来。
{
  const N = 432;
  const inner = Math.round(N * 0.66);
  // 先挖底再摆进去：源图的底色是烤进去的，不挖的话前景层会是一个实心方块
  const scaled = knockout(
    resize(src.data, src.width, src.height, inner, inner), inner, inner, BG,
  );
  const fg = Buffer.alloc(N * N * 4); // 全透明
  const off = Math.round((N - inner) / 2);
  for (let y = 0; y < inner; y += 1) {
    scaled.copy(fg, ((y + off) * N + off) * 4, y * inner * 4, (y + 1) * inner * 4);
  }
  write('android-icon-foreground.png', fg, N, N);

  const bg = Buffer.alloc(N * N * 4);
  for (let i = 0; i < N * N; i += 1) {
    bg[i * 4] = BG[0]; bg[i * 4 + 1] = BG[1]; bg[i * 4 + 2] = BG[2]; bg[i * 4 + 3] = 255;
  }
  write('android-icon-background.png', bg, N, N);

  // 单色图标：Android 13+ 的主题图标，只看 alpha。把非底色的地方涂成不透明黑。
  const mono = Buffer.alloc(N * N * 4);
  for (let i = 0; i < N * N; i += 1) {
    const o = i * 4;
    const isBg = Math.abs(fg[o] - BG[0]) < 18 && Math.abs(fg[o + 1] - BG[1]) < 18
      && Math.abs(fg[o + 2] - BG[2]) < 18;
    const on = fg[o + 3] > 40 && !isBg;
    mono[o] = 0; mono[o + 1] = 0; mono[o + 2] = 0;
    mono[o + 3] = on ? 255 : 0;
  }
  write('android-icon-monochrome.png', mono, N, N);
}

console.log('好了。图标产物进 git，运行期不依赖 pngjs。');
