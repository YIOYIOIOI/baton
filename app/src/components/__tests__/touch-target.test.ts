import fs from 'node:fs';
import path from 'node:path';

/**
 * 「点加号没反应，弹出来的是模型配置」的回归护栏。
 *
 * 加号右边紧挨着「配置」药丸，两者体量差得很远：加号原来只有 34×34，药丸一百
 * 多宽。34 低于 iOS/Android 都认的 44 这条触摸下限，手指落点一偏，浏览器和系统
 * 在做触摸命中修正时就会挑中旁边那个大得多的目标。
 *
 * 这件事**只能在这里钉**：
 *   - 原生上本来该用 hitSlop 撑命中区，但 react-native-web 的 Pressable 根本
 *     没实现 hitSlop（只有老的 Touchable 有），网页端一写就是白写；
 *   - 而 app/ 这套同时跑在 Expo Go 和手机浏览器上，浏览器那条路没有真机验收。
 *
 * 读源码文本而不是 import：这些数写在 `StyleSheet.create` 的闭包里，拿不出来。
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'Composer.tsx'), 'utf8');

/** 从 `名字: { … }` 这样一段样式里取某个数值属性。 */
function styleNum(block: string, prop: string): number | null {
  const seg = new RegExp(`\\b${block}:\\s*\\{([^}]*)\\}`, 's').exec(SRC);
  if (!seg) return null;
  const m = new RegExp(`\\b${prop}:\\s*(\\d+(?:\\.\\d+)?)`).exec(seg[1]);
  return m ? parseFloat(m[1]) : null;
}

describe('输入框那一行的触摸目标', () => {
  /**
   * **两个平台不是同一个数**：iOS 44pt、Android 48dp。
   *
   * 上一版为了修「点加号却打中旁边的模型配置」，把两边统一成了 44——在 Android
   * 上那就是 44dp，仍然低于下限，而出问题的那台正好是安卓平板。装上的
   * ui-ux-pro-max 那份清单两处都把「一个数跨平台通用」列为反模式
   * （pro-rules.md 的 §Icons & Visual Elements 与 §Interaction）。
   */
  test('下限按平台分叉，不是一个数走天下', () => {
    const m = /const TOUCH_MIN = Platform\.OS === 'android' \? (\d+) : (\d+);/.exec(SRC);
    expect(m).not.toBeNull();
    const [, android, ios] = m as RegExpExecArray;
    expect(Number(android)).toBeGreaterThanOrEqual(48);
    expect(Number(ios)).toBeGreaterThanOrEqual(44);
  });

  test('加号/停止、发送，命中盒都用那个下限', () => {
    for (const block of ['ghost', 'sendHit']) {
      const seg = new RegExp(`\\b${block}:\\s*\\{([^}]*)\\}`, 's').exec(SRC);
      expect(seg).not.toBeNull();
      expect((seg as RegExpExecArray)[1]).toMatch(/width:\s*TOUCH_MIN,\s*height:\s*TOUCH_MIN/);
    }
  });

  test('发送键画出来的那颗圆还是 36 —— 撑的是盒子，不是观感', () => {
    // 分量是调过的（发送重、传文件轻），把圆真画大就把那个关系破坏了
    expect(styleNum('dark', 'width')).toBe(36);
    expect(styleNum('dark', 'height')).toBe(36);
  });

  test('加号和「配置」药丸之间留出手指宽度', () => {
    const gap = styleNum('row', 'gap');
    expect(gap).not.toBeNull();
    // 8px 等于把两个目标贴在一起，而抢起来永远是小的那个输
    expect(gap as number).toBeGreaterThanOrEqual(12);
  });

  test('图标本身没跟着变大——变的只是吃手指的盒子，不是观感', () => {
    // 盒子撑到 44 的同时图标还是 19：这颗按钮的分量是调过的，真画大就破坏了
    expect(/IconPlus size=\{19\}/.test(SRC)).toBe(true);
  });
});
