import fs from 'node:fs';
import path from 'node:path';
import { glassPath, nativeTint, webTint } from '../Glass';

/**
 * 玻璃有三条实现路径，其中两条（web 的 backdrop-filter、不透明兜底）
 * 在 iOS 真机上永远走不到。真机验收覆盖不了它们，只能靠这里钉住。
 */

describe('走哪条路', () => {
  test('原生且模块可用 → 真玻璃', () => {
    expect(glassPath({ web: false, module: true, reduceTransparency: false })).toBe('native');
  });

  test('网页 → backdrop-filter', () => {
    expect(glassPath({ web: true, module: false, reduceTransparency: false })).toBe('web');
  });

  test('原生但模块拿不到（iOS 26 以下、Android）→ 不透明兜底', () => {
    // **不能返回全透明**：底下是滚动内容，没有底色时文字会和内容糊在一起
    expect(glassPath({ web: false, module: false, reduceTransparency: false })).toBe('opaque');
  });

  test('开了「降低透明度」→ 一律不透明，压过其余一切', () => {
    // 用户在系统里明确说了「别给我半透明」。这时退到 web 的模糊也是违背，
    // 所以它必须排在最前面判。
    expect(glassPath({ web: false, module: true, reduceTransparency: true })).toBe('opaque');
    expect(glassPath({ web: true, module: false, reduceTransparency: true })).toBe('opaque');
  });
});

/**
 * 底色有两个互相独立的维度：这块玻璃本身是不是深色药丸（dark），
 * 以及整个 App 在不在深色模式（isDark）。写死一个的后果是浏览器实测出来的：
 * 深色模式下底部操作条整条发白，压在暗页面上，完全不像浮着。
 */
describe('底色跟着深浅走', () => {
  const alpha = (c: string) => Number(c.match(/([\d.]+)\)$/)?.[1]);
  const lum = (c: string) => {
    const [r, g, b] = c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };

  test.each([['网页', webTint], ['原生', nativeTint]] as const)('%s：四种组合互不相同', (_, tint) => {
    const all = [tint(false, false), tint(false, true), tint(true, false), tint(true, true)];
    expect(new Set(all).size).toBe(4);
  });

  test.each([['网页', webTint], ['原生', nativeTint]] as const)('%s：浅色模式的浅玻璃比深色模式的浅玻璃亮', (_, tint) => {
    expect(lum(tint(false, false))).toBeGreaterThan(lum(tint(false, true)));
  });

  test.each([['网页', webTint], ['原生', nativeTint]] as const)('%s：深色药丸在深色模式下反过来是亮的', (_, tint) => {
    // bgInverse 在深色模式下就是浅色。药丸要和它一致，否则深色模式里
    // 「深色药丸」会和页底糊成一块，看不出是个按钮
    expect(lum(tint(true, true))).toBeGreaterThan(lum(tint(true, false)));
  });

  test('绝不透明度为零——底下是滚动内容，透底就和文字糊在一起', () => {
    for (const tint of [webTint, nativeTint]) {
      for (const [d, i] of [[false, false], [false, true], [true, false], [true, true]] as const) {
        expect(alpha(tint(d, i))).toBeGreaterThan(0.3);
      }
    }
  });
});

/**
 * HIG 的头号规矩：**玻璃只属于功能层**（导航、工具栏、底部附件、浮动按钮、sheet），
 * 内容层（列表行、消息流、Markdown、卡片）一律不上玻璃。
 *
 * 这条靠人自觉守不住——加一块玻璃只要一行，而后果要到真机上才看得出来
 * （层级糊成一片，每样东西都在抢注意力）。所以在这儿钉死。
 */
describe('玻璃不得出现在内容层', () => {
  const src = path.join(__dirname, '..', '..');
  const CONTENT_LAYER = [
    'components/stream.tsx',     // 会话流：消息气泡、工具块
    'components/markdown.tsx',   // 正文渲染
    'components/Attachments.tsx',// 附件缩略图（挂在输入区上方，但自身是内容）
    'app/welcome.tsx',           // 首屏是一整幅插画，玻璃会把它切碎
  ];

  test.each(CONTENT_LAYER)('%s 不引用 Glass', (rel) => {
    const code = fs.readFileSync(path.join(src, rel), 'utf8');
    expect(code).not.toMatch(/from\s+['"][^'"]*Glass['"]/);
  });
});/**
 * 材质、层序与形变。
 *
 * 这一组是**栽了七次**才钉下来的，每一次都只有装到手机上才看得出错：
 *
 *   1  轨道和胶囊都用 clear      →「框是透明玻璃，胶囊是磨砂，你搞反了」
 *   2  胶囊 clear 压到文字上面   →「默认状态下都挡住了文字」
 *   3  静止实色、按住才变玻璃    →「全都是错的」（做法对，错在没法截图验收）
 *   4  轨道磨砂 + 胶囊常驻玻璃   →「反而是底下的那个变成了透明玻璃」
 *   5  胶囊是轨道玻璃的子元素    →「胶囊没有溢出」＋ 落位发黑
 *   6  轨道换成半透明实色        →「首页底部的轨道现在是透明的，不应该是透明的」
 *   7  形变的比例算错           →「长按的时候根本没有溢出」
 *
 * 第 2 次之后读了 expo-glass-effect 的原生源码：GlassView 是 UIVisualEffectView，
 * mountChildComponentView 把子元素塞进 contentView——**子元素画在材质上面、
 * 不参与折射**，而且那层会裁剪。两条合起来解释了第 2 次和第 5 次。
 */
describe('玻璃材质', () => {
  const CR = String.fromCharCode(13);
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .split(CR).join('');

  test('Glass 的默认档是 regular', () => {
    // HIG 的排序：regular 覆盖约 95% 的场景。默认曾经是 clear，于是每一块玻璃
    // 都在折射，而纯白页底没东西可折射 -> 那颗「+ 新会话」整个隐形。
    expect(read('Glass.tsx')).toMatch(/variant = 'regular'/);
  });

  test('三个档位与 expo-glass-effect 的 GlassStyle 一一对应', () => {
    // 自己另立一套名字就得维护一层翻译，而翻译错了不会报错，只会渲染成别的东西
    expect(read('Glass.tsx')).toMatch(/GlassVariant = 'clear' \| 'regular' \| 'none'/);
  });
});

/**
 * ## 这里原本还有三组测试，共二十条，都删了
 *
 * 「材质、层序与形变」「Skia 透镜」「分段控件的手势」——钉的是我们自己写的那颗
 * 分段控件：三层玻璃的次序、胀大要真的超过轨道、PanResponder 只经 fns.current
 * 调用、着色器中间不动边缘才折射……
 *
 * 那些**当时全是对的**，每一条都对应上面列的某一次真机翻车。但它们钉的那套
 * 实现整个没了：iOS 26 那颗液态玻璃滑块仿不出来，最后换成了系统的
 * `UISegmentedControl`（理由写在 Segmented.tsx 抬头）。钉一个不存在的实现没有
 * 意义，留着只会让人以为还得那么做。
 *
 * 教训没有丢——现在由系统负责，下面这一组负责挡住「再写一遍」。
 */
describe('分段控件用系统那颗，别再自己写', () => {
  // git 在 Windows 上按 autocrlf 检出成 CRLF，比对会被行尾干扰。
  // 用 split/join 去掉回车而**不写成正则**：生成这段代码的脚本会把那个转义
  // 解释成真的回车字节，把正则劈成两行、整个文件解析失败。本仓库第五次了。
  const CR = String.fromCharCode(13);
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .split(CR).join('');

  /**
   * 这颗控件的效果**只能**从系统那儿拿。
   *
   * 查证结论（见 Segmented.tsx 抬头）：公开的 `UIGlassEffect` 只有材质档、
   * tintColor、isInteractive 三个旋钮；tab bar 里那颗透镜是私有类
   * `_UILiquidLensView`；而**那个效果不对任意视图开放，只有 tab bar 和分段
   * 控件有**。用真的分段控件是唯一一条既拿得到效果、又不碰私有 API 的路。
   */
  test('内部是系统的 UISegmentedControl', () => {
    expect(read('Segmented.tsx')).toMatch(/@react-native-segmented-control/);
  });

  /**
   * **别再往这里加动画。**
   *
   * 位移、回弹、形变、玻璃全部由系统负责，再叠一层只会和它打架——上一版正是
   * 这么失败的：七百多行手势加四段着色器，追了十几轮还是「和官方不一样」。
   * 这条同时挡住手势：自己接管 PanResponder 等于把系统那颗滑块的拖动抢走。
   */
  test('不再自己做手势和动画', () => {
    const body = read('Segmented.tsx');
    expect(body).not.toMatch(/PanResponder/);
    expect(body).not.toMatch(/Animated\.(timing|spring)/);
  });

  /**
   * 选中那颗在拖动时会**鼓出控件边界**（系统行为）。祖先上任何 overflow:hidden
   * 都会把鼓出去的那部分切掉——这个坑在旧实现上踩过，换成系统控件之后依然成立。
   */
  test('外层不裁剪，否则鼓出去的部分会被切掉', () => {
    expect(read('Segmented.tsx')).toMatch(/overflow: 'visible'/);
  });
});
