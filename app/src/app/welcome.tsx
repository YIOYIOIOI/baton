import { useState } from 'react';
import { Image, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type Theme } from '@/theme';
import { PillDark, Tappable } from '@/components/ui';
import { useLocale } from '@/i18n';
import { useConnection } from '@/store/connection';

/**
 * 首屏。按 .design/01-welcome.png **逐像素复刻**——这是 owner 点名要照搬的那一屏。
 *
 * 构图要点：**插画铺底出血**，字标压在它之上。上面那只手从右上伸进来、上边和右边
 * 出血；下面那只手从左下伸进来、左边和下边出血。裁在框内就成了两只悬空的手，
 * 「交接」的意思就没了。
 *
 * 尺寸不是估的，照方案自己的合成脚本（.design/source/final_package.py）：
 *
 *     art = a.resize((1206, round(1206*1391/706)))   # 按画布**宽度**缩放
 *     im.paste(art, (0, -90), art)                   # 再整体上移 90 设备像素
 *
 * 画布 1206×2622 = 402×874 逻辑像素，所以逻辑单位下就是
 * 「宽度铺满、保持 706:1391、上移 30」。
 *
 * 尺寸由 onLayout 量出来的宽高算，踩过的两个坑都在这儿：
 *   useWindowDimensions()  Expo 静态渲染时返回 0，hydration 后也没有 resize 事件
 *                          把它纠回来 → width:0px，整张图不见（浏览器实测）
 *   aspectRatio            RN Web 会把图片的**固有高度**写进 style，
 *                          CSS 的 aspect-ratio 只在某一边为 auto 时生效，于是被顶掉，
 *                          结果盒子成了 402×1391，球被拉成椭圆（浏览器实测）
 * onLayout 给的是布局后的真实尺寸，两个平台行为一致。
 *
 * **按宽高两头收敛（contain），不是只铺宽度。** 只铺宽度在手机上没问题——手机的
 * 宽高比和设计稿接近，两条路算出来差 1、2 像素——但在浏览器里打开就散了：
 * 1024×768 时插画被撑到 1024×2017，屏幕只剩顶上一条，露出一只放大到荒谬的手
 * （浏览器实测）。整幅构图是按 402×874 画的，得当成一个固定比例的整体来放。
 */
const ART_RATIO = 1391 / 706;   // 高 / 宽
const ART_TOP = -30;            // 合成脚本里的 -90 设备像素 ÷ 3

/**
 * 字标也要跟着同一个系数缩放，不能写死字号。
 *
 * 插画随屏幕缩放，手的位置因此跟着变；字标若用固定字号，窄屏上它相对变大、
 * 相对位置不变，就会顶进右上那只手里。之前的 `translateX: -18` 就是在给这件事
 * 打补丁——把字往左推躲开手，代价是它不再居中，而且那个偏移量换个屏宽就不成立。
 *
 * 下面几个数是从 .design/01-welcome.png 量出来的（scripts/measure-design.mjs，
 * 画布 1206×2622 = 402×874 逻辑像素）：
 *   字标中心 200.8，画布中心 201.0   —— 设计稿里它本来就是正中的
 *   升部高 23.0                      —— 折合字号约 32，不是 44
 *   字形顶 y=90
 */
const DESIGN_W = 402;      // 设计稿逻辑宽度，所有比例的基准
const DESIGN_H = 874;      // 设计稿逻辑高度
const MARK_SIZE = 32;      // @402
const MARK_TOP = 78;       // @402，文本盒顶；字形顶再往下约 12（行高留白 + 升部）
const MARK_TRACKING = -1.3;

export default function WelcomeScreen() {
  const t = useTheme();
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const { isEn, setPref, en, trNew } = useLocale();
  const pendingUnpair = useConnection((state) => state.pendingUnpair);
  const storageError = useConnection((state) => state.unpairStorageError);
  const s = styles(t);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const next = { w: Math.round(width), h: Math.round(height) };
    if (next.w > 0 && (next.w !== box.w || next.h !== box.h)) setBox(next);
  };

  // 整幅构图的缩放系数：宽高两头都不许溢出。字标与插画共用它，
  // 两者的相对位置才在任何屏幕上都等于设计稿——否则窄屏上字相对变大，撞进手里。
  const k = box.w > 0 && box.h > 0
    ? Math.min(box.w / DESIGN_W, box.h / DESIGN_H)
    : 0;
  const artW = Math.round(DESIGN_W * k);

  return (
    <View style={s.screen} onLayout={onLayout}>
      <Stack.Screen options={{ headerShown: false }} />

      {k > 0 ? (
        <Image
          source={t.isDark
            ? require('@/assets/images/handoff-dark.png')
            : require('@/assets/images/handoff.png')}
          style={[s.art, {
            width: artW,
            height: Math.round(artW * ART_RATIO),
            top: Math.round(ART_TOP * k),
            left: Math.round((box.w - artW) / 2), // 收敛后两侧的留白均分
          }]}
          resizeMode="stretch"
          accessibilityLabel={isEn ? en('welcome.artA11y') : '一只手把接力棒递给另一只手'}
        />
      ) : null}

      <Tappable
        style={[s.langBtn, { top: Math.max(14, inset.top + 8), right: 18 }]}
        onPress={() => setPref(isEn ? 'zh' : 'en')}
        accessibilityRole="button"
        accessibilityLabel={trNew('lang.label')}
      >
        <Text style={s.langTx}>{isEn ? '中文' : 'EN'}</Text>
      </Tappable>

      {/*
        上边距取两者的较大值：设计稿的位置优先，但绝不进刘海/灵动岛。
        设计稿画布 402×874 正是有刘海的机型，字形顶 90 本就在安全区下方约 30，
        所以正常情况下前者胜出，max 只在异常大的顶部安全区时兜底。

        k 尚未量出来时按设计稿原尺寸画：字比插画先出来一瞬，总好过字号为 0 的空屏。
      */}
      <Text
        style={[s.wordmark, {
          marginTop: Math.max(Math.round(MARK_TOP * (k || 1)), inset.top + 12),
          fontSize: Math.round(MARK_SIZE * (k || 1)),
          letterSpacing: MARK_TRACKING * (k || 1),
        }]}
      >
        Baton
      </Text>

      <View style={{ flex: 1 }} />
      {/* 自己处理底部安全区——Home 指示条会盖住贴边的按钮 */}
      {/*
        按钮不铺满宽度。铺满时它横跨整屏，正好压住插画里左下那只手的手腕——
        插画是这一屏的主角，按钮不该切断它。收窄居中之后两侧都能露出手。
      */}
      <View style={[s.actionWrap, { paddingBottom: Math.max(16, inset.bottom) }]}>
        {pendingUnpair && <Text accessibilityLiveRegion="polite">{trNew(storageError ? 'pair.unpairStorageError' : 'pair.unpairPending')}</Text>}
        <PillDark
          disabled={pendingUnpair}
          label={isEn ? en('welcome.connect') : '连接电脑'}
          onPress={() => router.push('/pair')}
          style={s.action}
        />
      </View>
    </View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary, overflow: 'hidden' },
    langBtn: {
      position: 'absolute', zIndex: 2,
      minHeight: 38, minWidth: 44, paddingHorizontal: 14, borderRadius: t.radius.full,
      backgroundColor: t.c.bgPrimary, borderWidth: 1,
      borderColor: t.isDark ? 'rgba(255,255,255,0.16)' : t.c.bdTertiary,
      justifyContent: 'center', alignItems: 'center',
      ...t.shadow,
    },
    langTx: { fontFamily: t.fonts.sans, fontSize: t.size.xs, fontWeight: t.weight.bold, color: t.c.txSecondary },
    // 宽高与 top/left 都由组件按 k 算好传进来，这里只留定位方式。
    // 尺寸显式给、不留给 RN Web 去填固有尺寸；盒子比例就是原图比例，所以
    // resizeMode 用 stretch 不会变形，又比 resizeMode="contain" 少一条
    // 浮点误差造成的发丝边（与上面布局层面的「contain 收敛」是两回事）。
    art: { position: 'absolute' },
    actionWrap: { alignItems: 'center', paddingHorizontal: 16 },
    // 收窄 + 封顶：小屏上按屏宽的 62% 走，大屏上不超过 260，
    // 免得在 iPad 之类的宽屏上变成一条横贯全屏的黑带
    action: { width: '62%', maxWidth: 260, minWidth: 190 },
    // 字号、字距、上边距都在组件里按屏宽算，这里只留与尺寸无关的部分
    wordmark: {
      fontFamily: t.fonts.sans, fontWeight: t.weight.bold,
      color: t.c.txPrimary, textAlign: 'center',
      // 居中就是居中：设计稿量下来字标中心 200.8、画布中心 201.0。
      // 之前那个 translateX: -18 是在给偏大的字号打补丁，把字推开躲手——
      // 代价是它不再居中，且偏移量换个屏宽就不成立。字号改对之后不需要它。
      position: 'relative', zIndex: 1, // 插画是 absolute，定位元素会盖住静态流内容
    },
  });
