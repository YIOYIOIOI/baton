import fs from 'node:fs';
import path from 'node:path';

/**
 * 用户可见文案不许重复写两遍。
 *
 * 这轮清理里删掉最多的就是它：同一句「心跳每 15 秒一次…」在列表页和会话页
 * 各写一遍、只差「上面/下面」两个字；连接状态的说法有**三份**（Notice 的
 * title、LinkDot 的 LABEL、LinkPill 的 LINK_LABEL），措辞各不相同；
 * 轮次结束的 stopped 与 aborted 一字不差，而其中一个的状态值根本不存在。
 *
 * 后果不是「多占几行」——是同一个状态在不同屏上叫不同名字，用户会以为
 * 碰到了两个不同的问题。而这条靠人自觉守不住：复制一句比抽出去快得多，
 * 且抄错一个字在 review 里看不出来。
 */

const SRC = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['__tests__', 'node_modules']);

/**
 * 长到值得抽出去的阈值。
 *
 * 4 是实测定的：'重试'、'取消'、'菜单'、'发送' 这类按钮词是 2–3 字，天然会
 * 重复且不该管；从 4 字起就是短语了。当前仓库在这个阈值下有 43 条不同文案、
 * 0 条跨文件重复。
 */
const MIN_LEN = 4;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sources(path.join(dir, e.name), out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 去掉注释——注释里引用旧文案是**应该的**（解释为什么改），不算重复。 */
const stripComments = (code: string) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 取出带中文的字符串字面量。JSX 里的裸文本不管——那本来就只出现一次。 */
function literals(code: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(code).matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
    const s = (m[1] ?? m[2] ?? '').trim();
    if (/[一-龥]/.test(s) && s.length >= MIN_LEN) out.push(s);
  }
  return out;
}

test(`长度 ${MIN_LEN} 以上的中文文案只许有一处出处`, () => {
  const where = new Map<string, Set<string>>();
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    for (const s of literals(fs.readFileSync(file, 'utf8'))) {
      if (!where.has(s)) where.set(s, new Set());
      where.get(s)!.add(rel);
    }
  }

  // 先确认真的扫到东西了。正则写错时这条测试会「通过」——因为一个都没匹配上，
  // 自然也就没有重复。当前实际 43 条，这个下界留足了删改余量。
  // （第一版这条就抓到过自己：阈值定成 9 字，收短文案之后只剩 13 条了。）
  expect(where.size).toBeGreaterThan(25);

  const dupes = [...where.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([s, files]) => `  「${s}」\n    出现在 ${[...files].join('、')}`);

  expect(dupes.join('\n') || null).toBeNull();
});
