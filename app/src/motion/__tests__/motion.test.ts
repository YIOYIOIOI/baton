import fs from 'node:fs';
import path from 'node:path';

/**
 * 动效的几条硬规矩。
 *
 * 这些全是**跨文件**的约束——单看任何一个文件都挑不出毛病，只有把整个 src
 * 扫一遍才看得见。所以它们只能测在这里，靠 review 是抓不住的：漏掉减弱动效
 * 不会报错、不会崩、在模拟器上也一切正常，只有开了那个系统开关的人才遇得到。
 *
 * 依据是 Apple 的 Designing Fluid Interfaces（WWDC 2018）与 HIG 的无障碍章节。
 */

const SRC = path.join(__dirname, '..', '..');

/** 把 src 下所有 .ts/.tsx 读出来。git 在 Windows 上按 autocrlf 检出成 CRLF，统一掉。 */
function allSources(): { rel: string; code: string }[] {
  const out: { rel: string; code: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      out.push({
        rel: path.relative(SRC, p).replace(/\\/g, '/'),
        code: fs.readFileSync(p, 'utf8').replace(/\r/g, ''),
      });
    }
  };
  walk(SRC);
  return out;
}

/** 去掉注释，免得注释里讲「别用 ease-in」的那句话被当成用了 ease-in。 */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('动效硬规矩', () => {
  const files = allSources();

  /**
   * ease-in **起步慢**，而起步那一刻正是用户盯着看的一刻——点下去之后先纹丝
   * 不动几十毫秒，读起来就是卡顿。哪怕是离场也用 ease-out：先动起来再收尾。
   *
   * 这条栽过一次：Sheet 的关闭动画配的是 `Easing.in(Easing.cubic)`，
   * 按「进来用 out、出去用 in」想当然配的。
   */
  test('UI 上不许出现 ease-in', () => {
    const bad = files
      .filter(({ code }) => /Easing\.in\s*\(/.test(stripComments(code)))
      .map(({ rel }) => rel);
    expect(bad).toEqual([]);
  });

  /**
   * 凡是会自己动起来的文件，都得问一句「用户是不是关掉了动效」。
   *
   * 例外只有一个，而且是有依据的：keyboard.ts 抄的是**系统键盘自己**的时长和
   * 曲线。系统键盘在减弱动效下照样滑，这时让输入框瞬跳反而会和键盘脱节——
   * 跟着系统走才是对的。例外写死在这儿，不是靠注释约定。
   */
  test('会动的东西都处理了减弱动效', () => {
    const EXEMPT = new Set([
      // 跟随系统键盘，见上
      'layout/keyboard.ts',
    ]);

    const animates = files.filter(({ rel, code }) => {
      if (EXEMPT.has(rel)) return false;
      const c = stripComments(code);
      return /Animated\.(timing|spring|loop|sequence)\s*\(|withTiming|withSpring/.test(c);
    });

    // 先确认这个筛子真的筛出了东西——筛子坏了会让这条测试静默通过
    expect(animates.length).toBeGreaterThan(0);

    const missing = animates
      .filter(({ code }) => !/useReduceMotion|reduceMotion/.test(code))
      .map(({ rel }) => rel);
    expect(missing).toEqual([]);
  });

  /**
   * tab 之间左右横移，和底部那条分段控件的滑块同向。
   *
   * 这条来回改过两次：'shift' → 'none' → 'shift'。第二次改的理由是「滑动表达的
   * 是层级，而 tab 是平级」，听起来站得住，但 owner 实际用下来要的是有——
   * 而且这一版底部那条已经是**系统的分段控件**，它自己的滑块就在左右滑，
   * 页面跟着横移才是同一件事的两半；页面硬切、滑块滑动，读起来是两回事。
   *
   * 钉在这儿是因为它被翻过两次烧饼——再改要先看懂上面这段。
   */
  test('tab 切换跟着横移', () => {
    const layout = files.find(({ rel }) => rel === 'app/(tabs)/_layout.tsx');
    expect(layout).toBeDefined();
    expect(stripComments(layout!.code)).toMatch(/animation: 'shift'/);
  });

  /**
   * ## 这里原本有两条，钉的是我们自己写的那套手势
   *
   *   「松手按速度投射落点，用的是指数衰减那条」——苹果那条 (v/1000)·d/(1-d)，
   *     还必须夹在一格以内（owner：「轻轻往右一拨就直接滑到 codex 去了」）
   *   「拖到两端是阻尼不是硬夹」——rubberband，硬夹读起来像卡死
   *
   * 两条**当时都是对的**，但它们钉的那套实现整个没了：分段控件换成了系统的
   * `UISegmentedControl`，投射、阻尼、回弹全部由系统负责（理由写在
   * Segmented.tsx 抬头）。挡住「再写一遍」的那条现在在 glass.test.ts 里。
   */

  /**
   * 曲线只有一处出处。散在各文件里写贝塞尔控制点，迟早会出现两条略微不同的
   * 「同一条」曲线，而那种差别没人看得出是 bug，只会觉得某一处「怪怪的」。
   *
   * 曾经有一个例外（GlassSegmented.tsx，动画跑在 worklet 里要用 Reanimated
   * 自己的 Easing）。那个文件随自绘分段控件一起删了，现在没有例外。
   */
  test('缓动曲线不许现配', () => {
    const bad = files
      .filter(({ rel }) => rel !== 'motion/curves.ts')
      .filter(({ code }) => /Easing\.bezier\s*\(/.test(stripComments(code)))
      .map(({ rel }) => rel);
    expect(bad).toEqual([]);
  });

  /**
   * 原本这儿还有一条：「GlassSegmented 的例外确实来自 Reanimated 的 Easing」。
   * 那个文件已经删了——它是自绘玻璃分段控件的 Reanimated 版本，从 Segmented 里
   * 把 `GlassSeg` 置空之后就一直是死代码，这次连同整套自绘实现一起清掉。
   * 上面那条「缓动曲线不许现配」的例外名单也跟着少了一项。
   */

});
