import { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type Theme } from '@/theme';
import { IconPlus } from '@/icons';
import { Glass, GlassGroup, useGlassPath } from './Glass';
import { PillGlass } from './ui';
import { ScrollEdge } from './ScrollEdge';
import { Segmented } from './Segmented';
import { useLocale } from '@/i18n';

/**
 * 底部那条。**两页之间的切换器 + 主操作**。
 *
 * 它是 tabs 的 tabBar，也就是说它活在两个页面**之外**——换页时它不重建、
 * 不闪烁。上一版把它写在每一页里、靠 router.replace 互切，owner 实测到
 * 「底部切换栏会整个消失再出现」，就是那个结构的必然结果。
 *
 * 切换器复用 Segmented——那套玻璃形变和长按拖动已经在了，两处同一个控件，
 * 手感自然一致。
 */

export type Page = 'sessions' | 'settings';

const PAGES = [['sessions', '会话'], ['settings', '设置']] as const;

/** tab 的路由名，和 (tabs)/ 下的文件名对应 */
const ROUTE: Record<Page, string> = { sessions: 'index', settings: 'about' };

/**
 * 切换器的固定宽度。**固定而不是跟着文字缩**：两页的文字长度不同，
 * 跟着缩的话整条 dock 会在换页时跳一下。
 */
const SWITCHER_W = 168;
/**
 * 切换器的高度。
 *
 * 系统分段控件的固有高度是照「设置页里的一行」定的，放在浮动 dock 上偏小；
 * owner 对着 App Store 和 Telegram 的底栏要的是「大个」的观感，那两条都在 50pt
 * 上下。和右边那颗新会话胶囊同高，融合起来才是一条完整的轨道。
 */
const SWITCHER_H = 50;

/** dock 本体的高度（不含底部安全区）：上内边距 + 最高那颗。 */
const DOCK_BODY = 10 + SWITCHER_H;

/**
 * 滚动区要留的底部空间。
 *
 * 直接算而不是量：dock 是绝对定位浮在上面的，它不占布局空间，量不到；
 * 而它的高度由内边距和里面最高那颗决定，是个定值。
 */
export function useDockHeight(): number {
  const inset = useSafeAreaInsets();
  return DOCK_BODY + Math.max(12, inset.bottom);
}

/**
 * tabBar 的入参里只取这两样。
 *
 * 不从 @react-navigation/bottom-tabs 引 BottomTabBarProps：expo-router 自带了
 * 一套同名但不兼容的类型，两边对不上会报一长串结构不匹配。只声明用到的字段，
 * 既过得了类型检查，也不把这个组件绑死在某一版导航库上。
 */
type TabBarSlice = {
  state: { index: number; routes: { name: string }[] };
  navigation: { navigate: (name: string) => void };
};

export function PageDock({ state, navigation }: TabBarSlice) {
  const t = useTheme();
  const s = styles(t);
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const glassPath = useGlassPath();
  const { isEn, en } = useLocale();

  const current = state.routes[state.index]?.name;
  const page: Page = current === ROUTE.settings ? 'settings' : 'sessions';
  const items = useMemo(
    () => (isEn
      ? [['sessions', en('dock.sessions')], ['settings', en('dock.settings')]] as const
      : PAGES),
    [isEn, en],
  );
  const edgeH = DOCK_BODY + Math.max(12, inset.bottom) + 18;
  const switcherH = Platform.OS === 'web' ? SWITCHER_H - 2 : SWITCHER_H;

  return (
    <>
      <ScrollEdge
        edge="bottom"
        height={edgeH}
        color={page === 'settings' ? t.c.bgGrouped : t.c.bgTertiary}
      />
      <View
        style={[s.dock, { paddingBottom: Math.max(12, inset.bottom) }]}
        // 两侧是空的，那儿的滑动要落到内容上，不能被一块透明的全宽 View 吃掉
        pointerEvents="box-none"
      >
        {/*
          **两块玻璃并排，靠近时由 GlassContainer 粘连。**

          owner 对着 Telegram 的底栏要的就是这个：点右边那颗，它放大时和左边那条
          并成一体。查官方文档之后，上一版合不起来的原因很简单——

              容器里**只有一块玻璃**。左边那颗是系统的 UISegmentedControl，
              它不是 UIVisualEffectView，容器眼里根本没有它，一块东西没法融合。

          所以轨道改由我们自己的 Glass 提供，分段控件 `transparent` 让位坐在上面。
          两块都是 GlassView，容器才有得合。

          文档里另外两条也核对过了：
            - 子元素要直接挂在 contentView 上 —— expo 的 mountChildComponentView
              就是这么做的
            - **别给子元素设 clipsToBounds / layer.cornerRadius**，会挡住融合；
              要用 cornerConfiguration —— expo 的 updateBorderRadius 用的正是它，
              所以圆角不是障碍

          spacing 给 12，比两颗之间 8pt 的间距略大：平时微微相吸，按下放大时并成一条。

          ## 掉帧的来源（owner：「底部栏的动画有点掉帧，但是顶栏的不会」）

          两条的差别不在代码质量，在**背景动不动**：

            顶栏  在静态头部里，背后那块不滚动 → 玻璃不用重新取样，1 层效果视图
            底栏  绝对定位浮在列表上，背后每帧都在变 → 每帧重新取样，而且是 **3 层**
                  （容器 UIGlassContainerEffect + 轨道 UIGlassEffect + 按钮 UIGlassEffect）

          3 层里有 2 层是为了「粘连」才有的：容器负责合并，轨道那层负责当被合并的
          另一块（系统分段控件不是 UIVisualEffectView，容器看不见它）。也就是说
          **粘连和帧率在这儿是同一笔账**：

            留着       3 层，能粘连，滚动时偏重
            去掉容器   2 层，不粘连，轻一档

          没有第三种——除非 expo-glass-effect 哪天让 GlassView 本体就是效果视图，
          那样系统控件也许能参与合并。要改先量，别凭感觉换。
        */}
        <GlassGroup spacing={12} style={s.cluster}>
          <Glass radius={999} style={[s.bar, glassPath === 'opaque' && t.shadow]}>
            <Segmented
              width={SWITCHER_W}
              height={switcherH}
              transparent
              items={items}
              value={page}
              onChange={(next) => {
                if (next === page) return;
                navigation.navigate(ROUTE[next]);
              }}
            />
          </Glass>
          <PillGlass
            label={isEn ? en('dock.new') : '新会话'}
            icon={<IconPlus size={16} color={t.c.coral} strokeWidth={2.3} />}
            onPress={() => router.push('/new')}
            style={s.newPill}
          />
        </GlassGroup>
      </View>
    </>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    // 只是个定位容器，自己没有底色——底色在里面那几块玻璃上
    dock: {
      position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: t.z.dock,
      alignItems: 'center', paddingHorizontal: t.space.pad, paddingTop: 10,
    },
    cluster: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    // 轨道那块玻璃。不裁剪——融合时那两块要能往彼此那儿伸出去
    bar: { height: SWITCHER_H, justifyContent: 'center', overflow: 'visible' },
    newPill: { height: SWITCHER_H, justifyContent: 'center' },
  });
