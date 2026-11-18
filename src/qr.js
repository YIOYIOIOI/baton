/**
 * 二维码编码器。字节模式 + ECC 等级 M，版本 1–10。
 *
 * 为什么自己写：Baton 后端是零依赖的（package.json 的 dependencies 是空的），
 * 为了配对时少打 12 个字符而引一个库，破坏的是一条已经成立的性质。
 * 而 QR 是个规格明确的算法，不是需要靠库来兜住的复杂领域。
 *
 * 只做够用的部分，**不做通用编码器**：
 *   - 只有字节模式——要编的是 URL，数字/字母数字模式压根用不上
 *   - 只有 ECC 等级 M——屏幕上拍照的场景，L 太脆、Q/H 浪费容量
 *   - 版本 1–10——最长的 URL 也就六十来字符，v10 能装 213 字节
 * 少写的每一部分都是确定用不到的，不是偷懒。
 *
 * 掩码**八种全做并按规范打分**，不是固定挑一个：掩码选错会出现大片同色区域，
 * 有些手机就是扫不出来，而这种失败没有任何提示，只会让人觉得"这破码不好使"。
 */

// ── GF(256) ─────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR 用的本原多项式
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 生成多项式：(x-α⁰)(x-α¹)…(x-α^(n-1)) */
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j += 1) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function ecc(data, n) {
  const g = generator(n);
  const rem = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i += 1) rem[i] ^= mul(g[i + 1], factor);
  }
  return rem;
}

// ── 版本表（ECC 等级 M）─────────────────────────
// [数据码字总数, 每块 EC 码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]

const VERSIONS = {
  1: [16, 10, 1, 16, 0, 0],
  2: [28, 16, 1, 28, 0, 0],
  3: [44, 26, 1, 44, 0, 0],
  4: [64, 18, 2, 32, 0, 0],
  5: [86, 24, 2, 43, 0, 0],
  6: [108, 16, 4, 27, 0, 0],
  7: [124, 18, 4, 31, 0, 0],
  8: [154, 22, 2, 38, 2, 39],
  9: [182, 22, 3, 36, 2, 37],
  10: [216, 26, 4, 43, 1, 44],
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** 能装下这些字节的最小版本。头部固定 12 bit（4 位模式 + 8 位长度，v1–9 都是 8 位）。 */
function pickVersion(len) {
  for (let v = 1; v <= 10; v += 1) {
    const bits = VERSIONS[v][0] * 8;
    const need = 4 + (v <= 9 ? 8 : 16) + len * 8;
    if (need <= bits) return v;
  }
  throw new Error(`内容太长（${len} 字节），本实现最多到版本 10（213 字节）`);
}

// ── 数据编码 ────────────────────────────────────

function encodeData(bytes, version) {
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i -= 1) bits.push((val >> i) & 1); };

  push(0b0100, 4);                      // 字节模式
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacity = VERSIONS[version][0] * 8;
  push(0, Math.min(4, capacity - bits.length)); // 终止符，不足 4 位就少补几位
  while (bits.length % 8) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  // 填充字节，规范规定就是这两个值交替
  const PAD = [0xec, 0x11];
  while (words.length < VERSIONS[version][0]) words.push(PAD[(words.length - bits.length / 8) % 2]);
  return words;
}

/**
 * 分块、算 EC、交错。
 * 交错是**必须**的：不交错的话一处污损会集中打在一个块上，超出该块的纠错能力；
 * 交错后同样面积的污损被摊到所有块，每块都还救得回来。
 */
function interleave(words, version) {
  const [, ecLen, g1, d1, g2, d2] = VERSIONS[version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1; i += 1) { blocks.push(words.slice(at, at + d1)); at += d1; }
  for (let i = 0; i < g2; i += 1) { blocks.push(words.slice(at, at + d2)); at += d2; }

  const eccs = blocks.map((b) => ecc(b, ecLen));
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i += 1) for (const e of eccs) out.push(e[i]);
  return out;
}

// ── 矩阵 ────────────────────────────────────────

function newMatrix(size) {
  return {
    size,
    m: Array.from({ length: size }, () => new Int8Array(size).fill(-1)), // -1 = 还没放
    set(r, c, v) { this.m[r][c] = v; },
    get(r, c) { return this.m[r][c]; },
    free(r, c) { return this.m[r][c] === -1; },
  };
}

function placeFunction(mx, version) {
  const n = mx.size;
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        mx.set(rr, cc, on ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  // 定位图形
  for (let i = 8; i < n - 8; i += 1) {
    const v = i % 2 === 0 ? 1 : 0;
    mx.set(6, i, v);
    mx.set(i, 6, v);
  }

  // 校正图形：与定位图形重叠的那几处不放
  const pos = ALIGN[version];
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          mx.set(r + dr, c + dc, on ? 1 : 0);
        }
      }
    }
  }

  mx.set(n - 8, 8, 1); // 固定的深色模块

  // 格式信息区先占位，真值稍后写（它依赖掩码编号）
  for (let i = 0; i <= 8; i += 1) {
    if (mx.free(8, i)) mx.set(8, i, 0);
    if (mx.free(i, 8)) mx.set(i, 8, 0);
  }
  for (let i = 0; i < 8; i += 1) {
    if (mx.free(8, n - 1 - i)) mx.set(8, n - 1 - i, 0);
    if (mx.free(n - 1 - i, 8)) mx.set(n - 1 - i, 8, 0);
  }

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const b = (bits >> i) & 1;
      mx.set(Math.floor(i / 3), n - 11 + (i % 3), b);
      mx.set(n - 11 + (i % 3), Math.floor(i / 3), b);
    }
  }
}

function versionBits(v) {
  let d = v << 12;
  for (let i = 0; i < 6; i += 1) if ((d >> (17 - i)) & 1) d ^= 0x1f25 << (5 - i);
  return (v << 12) | d;
}

function formatBits(mask) {
  const ECC_M = 0b00;
  const data = (ECC_M << 3) | mask;
  let d = data << 10;
  for (let i = 0; i < 5; i += 1) if ((d >> (14 - i)) & 1) d ^= 0x537 << (4 - i);
  return ((data << 10) | d) ^ 0x5412;
}

function placeFormat(mx, mask) {
  const n = mx.size;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const b = (bits >> i) & 1;
    // 左上
    if (i < 6) mx.set(8, i, b);
    else if (i === 6) mx.set(8, 7, b);
    else if (i === 7) mx.set(8, 8, b);
    else if (i === 8) mx.set(7, 8, b);
    else mx.set(14 - i, 8, b);
    // 右上 / 左下
    if (i < 8) mx.set(8, n - 1 - i, b);
    else mx.set(n - 15 + i, 8, b);
  }
}

/** 之字形放数据：从右下角起，每次两列，交替上下。跳过第 6 列（定位图形）。 */
function placeData(mx, words) {
  const n = mx.size;
  const bits = [];
  for (const w of words) for (let i = 7; i >= 0; i -= 1) bits.push((w >> i) & 1);

  let at = 0;
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // 第 6 列整列是定位图形
    for (let i = 0; i < n; i += 1) {
      const row = up ? n - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!mx.free(row, c)) continue;
        mx.set(row, c, at < bits.length ? bits[at] : 0);
        at += 1;
      }
    }
    up = !up;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 规范的四条罚分规则。分越低越好。 */
function penalty(m, n) {
  let score = 0;

  // 规则 1：同色连续 5 个以上
  for (const rows of [true, false]) {
    for (let a = 0; a < n; a += 1) {
      let run = 1;
      for (let b = 1; b < n; b += 1) {
        const cur = rows ? m[a][b] : m[b][a];
        const prev = rows ? m[a][b - 1] : m[b - 1][a];
        if (cur === prev) { run += 1; } else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // 规则 2：2×2 同色块
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // 规则 3：形如 1011101 且一侧有 4 个浅色——会被误认成定位图形
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (const rows of [true, false]) {
    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b + 11 <= n; b += 1) {
        let m1 = true;
        let m2 = true;
        for (let k = 0; k < 11; k += 1) {
          const v = rows ? m[a][b + k] : m[b + k][a];
          if (v !== P1[k]) m1 = false;
          if (v !== P2[k]) m2 = false;
        }
        if (m1 || m2) score += 40;
      }
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) dark += m[r][c];
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

// ── 对外 ────────────────────────────────────────

/**
 * 编成一个 0/1 的二维数组（1 = 深色）。
 * 不含静区——静区由渲染方负责，因为终端和图片的留白方式不一样。
 */
export function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(bytes.length);
  const words = interleave(encodeData(bytes, version), version);
  const n = 17 + 4 * version;

  // 功能图形的位置在所有掩码下都一样，先算一次，用来判断哪些格子不该被掩码
  const base = newMatrix(n);
  placeFunction(base, version);
  const reserved = base.m.map((row) => Array.from(row, (v) => v !== -1));

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const mx = newMatrix(n);
    placeFunction(mx, version);
    placeData(mx, words);
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        // 只掩码数据区——功能图形被掩掉就没法定位了
        if (!reserved[r][c] && MASKS[mask](r, c)) mx.set(r, c, mx.get(r, c) ^ 1);
      }
    }
    placeFormat(mx, mask);
    const grid = mx.m.map((row) => Array.from(row));
    const score = penalty(grid, n);
    if (!best || score < best.score) best = { score, grid, mask };
  }
  return best.grid;
}

/**
 * 渲染成 SVG。终端字体、ANSI 颜色和行间隙在不同宿主里不可靠，
 * 配对二维码的最终展示应走这个矢量版本：模块边界是整数像素，
 * 浏览器放大后不会出现横线、抗锯齿或半块字符的缝。
 */
export function toSvg(grid, { quiet = 4, scale = 20 } = {}) {
  const n = grid.length;
  const q = Math.max(4, Math.floor(Number(quiet) || 4));
  const s = Math.max(1, Math.floor(Number(scale) || 20));
  const size = n + q * 2;
  const rects = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (grid[r][c]) rects.push(`<rect x="${c + q}" y="${r + q}" width="1" height="1"/>`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * s}" height="${size * s}" shape-rendering="crispEdges">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    `<g fill="#000">${rects.join('')}</g>`,
    '</svg>',
    '',
  ].join('\n');
}

/**
 * 渲染成终端能看的方块。
 *
 * 用半块字符（▀）把两行压成一行；调用方可以用 scale 放大终端里的每个模块。
 * 标准静区是 4 个模块，不能为了省行数把二维码压到贴边。
 *
 * 不依赖终端默认颜色：用黑底白字明确画出「深色模块 + 浅色底」。
 * 这里把矩阵位反过来映射到半块字符：原矩阵的深色模块落在黑色背景，
 * 原矩阵的浅色模块落在白色前景。这样即使终端面板忽略黑色前景，也仍然是可扫的高对比二维码。
 */
export function toTerminal(grid, { quiet = 4, scale = 1 } = {}) {
  const n = grid.length;
  const at = (r, c) => (r < 0 || c < 0 || r >= n || c >= n ? 0 : grid[r][c]);
  // 颜色一行只设一次。每个字符都重发一遍的话输出会膨胀到三倍多，
  // 而颜色在一行里根本不变。
  const START = '\x1b[40;37m'; // 黑底白字；矩阵位在下方反向映射
  const GAP = '\x1b[47;30m';   // 行间隙也要保持白底，不能露出终端黑底
  const RESET = '\x1b[0m';
  const zoom = Math.max(1, Math.floor(Number(scale) || 1));
  const lines = [];
  for (let r = -quiet; r < n + quiet; r += 2) {
    let line = START;
    for (let c = -quiet; c < n + quiet; c += 1) {
      const top = at(r, c);
      const bot = at(r + 1, c);
      // ▀ 用前景画上半格、背景画下半格，于是一行字符能表达两行模块
      // 黑色模块用背景（空白），白色模块用前景（方块）。
      // 半块字符的上/下半边分别对应两个模块，所以要反过来判断。
      if (!top && !bot) line += '█';
      else if (!top) line += '▀';
      else if (!bot) line += '▄';
      else line += ' ';
    }
    const rendered = line + GAP;
    for (let i = 0; i < zoom; i += 1) lines.push(rendered.replace(/([█▀▄ ])/g, (ch) => ch.repeat(zoom)));
  }
  return lines.join('\n') + RESET;
}
