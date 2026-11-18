import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { encode, toSvg, toTerminal } from '../src/qr.js';

/**
 * 二维码这种东西，「看起来像」和「扫得出来」是两回事，而且肉眼分不出来。
 * 所以主力测试是**拿一个外部解码器解回去**——jsQR，收在 test/fixtures/ 里。
 *
 * 为什么不自己写个解码器来验：自己写的解码器会和编码器共享同一套假设，
 * 于是「之字形放反了」这类系统性错误会一路对称地错下去，round-trip 照样绿。
 * 外部解码器不共享任何假设，这才是真的验。
 */
const require = createRequire(import.meta.url);
const jsQRModule = require('./fixtures/jsqr.cjs');
const jsQR = jsQRModule.default ?? jsQRModule;

/** 把 0/1 矩阵铺成 RGBA 像素，模块放大 S 倍、四周留 Q 个模块的静区。 */
function rasterize(grid, { scale = 4, quiet = 4 } = {}) {
  const n = grid.length;
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const r = Math.floor(y / scale) - quiet;
      const c = Math.floor(x / scale) - quiet;
      if (r >= 0 && c >= 0 && r < n && c < n && grid[r][c]) {
        const o = (y * size + x) * 4;
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
      }
    }
  }
  return { data, size };
}

const roundTrip = (text, opts) => {
  const { data, size } = rasterize(encode(text), opts);
  return jsQR(data, size, size)?.data ?? null;
};

test('高清二维码使用 SVG 与标准静区，不依赖终端字符画', () => {
  const svg = toSvg(encode('https://baton-local.example.com/pair?c=Q2W3E4R5T6Y7'));
  assert.match(svg, /<svg[^>]+shape-rendering="crispEdges"/);
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /<g fill="#000">/);
  assert.doesNotMatch(svg, /<line|stroke=/);
});
test('真实配对链接能被外部解码器解回原文', () => {
  const url = 'https://baton.example.com/pair?c=ABCD2345EFGH';
  assert.equal(roundTrip(url), url);
});

test('跨版本都对——内容长度不同会落到不同版本', () => {
  // 版本变了，分块数、EC 码字数、校正图形位置全都跟着变，
  // 每一处都可能单独写错，所以要各版本都过一遍
  const cases = [
    'https://a.b/pair?c=Q2W3E4R5T6Y7',                                   // v3
    'https://baton.example.com/pair?c=AAAAAAAAAAAA',                      // v4
    'https://very-long-hostname-for-testing.example.com/pair?c=ABCD2345', // v5
    `https://x.example.com/pair?c=ABCDEFGH2345&extra=${'y'.repeat(60)}`,  // 更高版本
  ];
  for (const text of cases) {
    assert.equal(roundTrip(text), text, `这条没解回来：${text.slice(0, 40)}…`);
  }
});

test('局域网地址（http + 端口）也对', () => {
  // 不是所有人都有隧道，局域网直连是常见用法
  const url = 'http://192.168.1.23:3002/pair?c=ZZ99ZZ99ZZ99';
  assert.equal(roundTrip(url), url);
});

test('UTF-8 内容不乱码', () => {
  const s = '中文内容测试 Baton';
  assert.equal(roundTrip(s), s);
});

test('缩放到 2 倍仍能解——手机拍到的往往不大', () => {
  const url = 'https://baton.example.com/pair?c=ABCD2345EFGH';
  assert.equal(roundTrip(url, { scale: 2, quiet: 4 }), url);
});

// ── 结构 ────────────────────────────────────────

test('三个定位图形形状正确', () => {
  const g = encode('https://baton.example.com/pair?c=ABCD2345EFGH');
  const n = g.length;
  const ok = (r0, c0) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const on = (r === 0 || r === 6 || c === 0 || c === 6)
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        if (g[r0 + r][c0 + c] !== (on ? 1 : 0)) return false;
      }
    }
    return true;
  };
  assert.ok(ok(0, 0) && ok(0, n - 7) && ok(n - 7, 0));
});

test('定位图形之间交替，固定深色模块在位', () => {
  const g = encode('https://baton.example.com/pair?c=ABCD2345EFGH');
  const n = g.length;
  for (let i = 8; i < n - 8; i += 1) {
    assert.equal(g[6][i], i % 2 === 0 ? 1 : 0, `第 6 行第 ${i} 列的交替不对`);
  }
  assert.equal(g[n - 8][8], 1, '固定深色模块必须是 1');
});

test('选出的掩码让深色比例接近一半', () => {
  // 偏得太多说明掩码没选对——有些手机对失衡的码就是扫不出来，且毫无提示
  const g = encode('https://baton.example.com/pair?c=ABCD2345EFGH');
  const n = g.length;
  const dark = g.flat().reduce((a, b) => a + b, 0);
  const pct = (dark * 100) / (n * n);
  assert.ok(pct > 40 && pct < 60, `深色占比 ${pct.toFixed(1)}%，偏离太多`);
});

test('超出实现范围时明确报错，不悄悄出一个扫不了的码', () => {
  assert.throws(() => encode('x'.repeat(300)), /版本 10/);
});

// ── 终端渲染 ────────────────────────────────────

test('终端渲染自带高对比颜色与静区', () => {
  // 多数终端是深色底，而扫码要求「深色模块 + 浅色底」。
  // 直接用终端底色会让整个码反相，很多解码器就不认了。
  const out = toTerminal(encode('https://a.b/pair?c=Q2W3E4R5T6Y7'));
  assert.match(out, /\x1b\[40;37m/, '必须显式设黑底白字');
  assert.match(out.split('\n')[0], /\x1b\[47;30m$/, '每行末尾必须把行间隙恢复为白底');

  // 颜色一行只设一次：每个字符都重发一遍会让输出膨胀三倍多，而颜色在一行里不变
  const perLine = (out.split('\n')[1].match(/\x1b\[40;37m/g) ?? []).length;
  assert.equal(perLine, 1, '一行里颜色码只该出现一次');

  const lines = out.split('\n');
  assert.ok(lines.length > 10);
  // 半块字符把两行压成一行，行数大约是模块数的一半——否则终端放不下，
  // 而滚动着的二维码扫不了
  assert.ok(lines.length < 25, `渲染了 ${lines.length} 行，太高了`);
});
