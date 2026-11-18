import { useEffect, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type Theme } from '@/theme';
import { IconCamera } from '@/icons';
import { useFloatBarHeight } from '@/components/ui';
import { pageOrigin, useConnection } from '@/store/connection';
import { BatonError, LinkError } from '@/api/client';
import { linkInfo } from '@/components/Notice';
import { Scanner } from '@/components/Scanner';
import * as haptics from '@/feedback/haptics';
import { useLocale } from '@/i18n';

/**
 * 配对。整屏居中、一个大号等宽码框，别的什么都没有——**不做引导流程**。
 *
 * 与原型的两处差异，都因为原型画的时候配对码还是旧规格：
 *   8 位 → **12 位**（撤 Cloudflare Access 时从 40 bit 加长到 60 bit）
 *   纯数字 → **A–Z 与 2–9**（去掉了易混的 0O1I，所以可以放心自动转大写）
 * 照抄原型会做出一个装不下配对码的输入框——后端的网页客户端真踩过这个坑。
 *
 * **地址框只在原生端出现。** 网页端这个页面就是 Baton 自己发的，地址栏里写着，
 * 再问一遍是没道理的——owner 第一眼就说「逻辑很怪」，确实怪。原生 app 没有
 * 「当前页面来源」这个东西，不问就不知道连哪台电脑，所以那边必须留着（只问一次，
 * 之后存 Keychain）。
 */
export default function PairScreen() {
  const t = useTheme();
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const pair = useConnection((s) => s.pair);
  const savedUrl = useConnection((s) => s.baseUrl);
  const { locale, isEn, setPref, en, trNew } = useLocale();

  // 「要不要问地址」必须用 Platform.OS 判，**不能用 pageOrigin()**：
  // Expo 的静态渲染跑在 Node 里，那时没有 location，pageOrigin() 返回 null，
  // 地址框就会被预渲染进 HTML，等浏览器接管后再消失——闪一下。
  // Platform.OS 在打包时就定死了，服务端和客户端算出来一样。
  const isWeb = Platform.OS === 'web';
  // 真正的地址仍然从 location 取，那一步只在浏览器里跑
  const origin = isWeb ? pageOrigin() : null;

  // 两条扫码路径，都落到同一个 `scanned` 上：
  //   ?c=…        在浏览器里打开带参数的链接（比如把链接发给自己）
  //   app 内扫码   iOS 主屏应用里唯一可行的那条，见 components/Scanner.tsx
  const { c: fromUrl } = useLocalSearchParams<{ c?: string }>();

  const [scanned, setScanned] = useState(normalizeCode(fromUrl));
  const [url, setUrl] = useState(savedUrl ?? '');
  const [code, setCode] = useState(normalizeCode(fromUrl));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; fix: string } | null>(null);
  const [focus, setFocus] = useState(false);
  const [autoTried, setAutoTried] = useState(false);
  const [scanning, setScanning] = useState(false);

  const ready = (isWeb || url.trim().length > 0) && code.length === 12;

  async function go() {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await pair(origin ?? url, code);
      // 配对成功是这个 App 里最值得给一下的时刻：一次性的、有后果的、
      // 而且紧接着就跳走了——不给触感的话，跳转本身是唯一的确认
      haptics.success();
      router.replace('/');
    } catch (e) {
      // 配对码是一次性的，失败就废了一个。这一下要让人知道刚才那次没成
      haptics.fail();
      // 服务端给的 fix 是**可照做的**，直接渲染，不自己编一句
      if (e instanceof BatonError) setErr({ msg: e.message, fix: e.fix });
      else if (e instanceof LinkError) {
        const key = e.link === 'ok' ? null : e.link;
        const info = key ? linkInfo(key, locale) : null;
        setErr({ msg: info?.title ?? e.message, fix: info?.fix ?? '' });
      } else setErr({ msg: (e as Error).message, fix: '' });
    } finally {
      setBusy(false);
    }
  }

  // 扫码进来就自己配，不等用户再点一下「配对」——他已经做过一次动作了（扫）。
  // 只试一次：失败后停在这一屏让他看清原因，而不是无限重试。
  useEffect(() => {
    if (autoTried || busy) return;
    if (code.length !== 12 || !(isWeb || url.trim())) return;
    if (!scanned) return; // 手打的不自动提交——打到第 12 位就跳走会很突兀
    setAutoTried(true);
    go();
  }, [code, scanned, autoTried, busy, isWeb, url]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = styles(t);
  const barH = useFloatBarHeight();
  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false }} />
      <Pressable
        style={[s.langBtn, { top: Math.max(14, inset.top + 8) }]}
        onPress={() => setPref(isEn ? 'zh' : 'en')}
        accessibilityRole="button"
        accessibilityLabel={trNew('lang.label')}
      >
        <Text style={s.langTx}>{isEn ? '中文' : 'EN'}</Text>
      </Pressable>
      <ScrollView contentContainerStyle={[s.pair, { paddingTop: barH }]} keyboardShouldPersistTaps="handled">
        {/*
          字标，不是 Claude 的 spike。原来那颗蓝星是 Claude Code 的标记——
          放在我们自己的配对页上既不对，也容易让人以为这是 Claude 官方的东西。
          用字标而不是 logo 里那颗球：孤零零一个圆点没有信息量，
          而这一屏是很多人（尤其是主屏快捷方式直接落这儿的人）看到的第一屏，
          它得先说清楚"这是什么"。
        */}
        <Text style={s.brand}>Baton</Text>
        <Text style={s.h1}>{isEn ? en('pair.h1') : '连上那台电脑'}</Text>
        <Text style={s.lede}>{isEn ? en('pair.lede') : '配一次就行，一年内不再问。'}</Text>

        {isWeb ? null : (
          <TextInput
            style={s.host}
            value={url}
            onChangeText={setUrl}
            placeholder={en('pair.hostPlaceholder')}
            placeholderTextColor={t.c.txTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            accessibilityLabel={isEn ? en('pair.hostA11y') : 'Baton 地址'}
          />
        )}

        <TextInput
          style={[
            s.codeIn,
            focus && { borderColor: t.c.coral },
            err && { borderColor: t.c.txDanger },
          ]}
          value={code}
          onChangeText={(v) => setCode(v.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 12))}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          placeholder="············"
          placeholderTextColor={t.c.txTertiary}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="one-time-code"
          maxLength={12}
          accessibilityLabel={isEn ? en('pair.codeA11y') : '12 位配对码'}
        />

        {err ? (
          <View style={s.errBox}>
            <Text style={s.err}>{err.msg}</Text>
            {err.fix ? <Text style={s.errFix}>{err.fix}</Text> : null}
          </View>
        ) : null}

        {/* 扫码是主路径，打字是备选——12 个字符在手机上打起来很烦，
            而且 iOS 上从主屏应用里扫是**唯一**可行的扫码方式：
            用系统相机扫会在 Safari 里配对，而那份凭据主屏应用看不到。 */}
        <Pressable
          style={s.scan}
          onPress={() => { setErr(null); setScanning(true); }}
          accessibilityRole="button"
        >
          <IconCamera size={19} color={t.c.txInverse} />
          <Text style={s.scanTx}>{isEn ? en('pair.scan') : '扫码配对'}</Text>
        </Pressable>

        <Pressable
          style={[s.go, !ready || busy ? { opacity: 0.35 } : null]}
          onPress={go}
          disabled={!ready || busy}
          accessibilityRole="button"
        >
          {busy ? <ActivityIndicator color={t.c.txPrimary} /> : <Text style={s.goTx}>{isEn ? en('pair.submit') : '用上面的码配对'}</Text>}
        </Pressable>

        <Text style={s.foot}>
          {isEn ? (
            <>
              {en('pair.footPrefix')}
              <Text style={s.mono}>baton pair</Text>
              {en('pair.footMid')}
            </>
          ) : (
            <>
              在电脑上执行 <Text style={s.mono}>baton pair</Text>，{'\n'}
              扫它打出来的二维码，或手打那 12 位码。
            </>
          )}
        </Text>
      </ScrollView>

      <Scanner
        open={scanning}
        onClose={() => setScanning(false)}
        onScan={({ code: c, origin: o }) => {
          setScanning(false);
          setCode(c);
          // 扫到的链接里带着主机名，原生端连地址一起解决了——那边本来还得手打
          if (o && !isWeb) setUrl(o);
          setAutoTried(false); // 允许自动提交这一次
          setScanned(c);
        }}
      />
    </KeyboardAvoidingView>
  );
}

/**
 * 配对码归一化：大写、只留字母表里的字符、截到 12 位。
 * 扫码进来的参数可能被各种东西加工过（相机 app 有时会带尾随空格），
 * 而字母表去掉了 0O1I，所以大写化不会造成歧义。
 */
function normalizeCode(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return String(raw ?? '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 12);
}

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary },
    langBtn: {
      position: 'absolute', top: 18, right: 18, zIndex: 2,
      minHeight: 34, paddingHorizontal: 12, borderRadius: t.radius.full,
      backgroundColor: t.c.bgSecondary, borderWidth: t.hairline, borderColor: t.c.bdSecondary,
      justifyContent: 'center', alignItems: 'center',
    },
    langTx: { fontFamily: t.fonts.sans, fontSize: t.size.xs, fontWeight: t.weight.bold, color: t.c.txSecondary },
    // flexGrow + center：内容竖直居中，而不是全堆在顶上、下半屏空着。
    // 这一屏内容不多，顶部对齐会留出半屏空白——owner 反馈的「底部很多空白」
    // 其中一处就是这儿。
    pair: {
      flexGrow: 1, justifyContent: 'center',
      paddingHorizontal: t.space.pad, paddingBottom: t.space.pad,
      gap: 16, alignItems: 'center',
    },
    brand: {
      fontFamily: t.fonts.sans, fontSize: 34, fontWeight: t.weight.bold,
      letterSpacing: -1.2, color: t.c.txPrimary, marginBottom: 2,
    },
    h1: {
      fontFamily: t.fonts.serif, fontSize: t.size.xl, lineHeight: 32,
      letterSpacing: -0.4, textAlign: 'center', color: t.c.txPrimary,
    },
    lede: {
      color: t.c.txSecondary, fontSize: t.size.sm, lineHeight: 24,
      textAlign: 'center', fontFamily: t.fonts.sans,
    },
    host: {
      width: '100%', minHeight: t.space.tap,
      backgroundColor: t.c.bgSecondary, borderRadius: t.radius.lg,
      paddingHorizontal: 16, fontSize: t.size.sm, color: t.c.txSecondary,
      fontFamily: t.fonts.mono, textAlign: 'center',
    },
    codeIn: {
      width: '100%',
      fontFamily: t.fonts.mono, fontSize: 24, letterSpacing: 6.7, textAlign: 'center',
      paddingVertical: 16, paddingHorizontal: 10,
      borderRadius: t.radius.xl, borderWidth: 2, borderColor: 'transparent',
      backgroundColor: t.c.bgSecondary, color: t.c.txPrimary,
    },
    errBox: { alignSelf: 'stretch' },
    err: { fontSize: t.size.xs, lineHeight: 19, color: t.c.txDanger, textAlign: 'center', fontFamily: t.fonts.sans },
    errFix: { fontSize: t.size.xs, lineHeight: 19, color: t.c.txSecondary, textAlign: 'center', marginTop: 3, fontFamily: t.fonts.sans },
    scan: {
      width: '100%', minHeight: t.space.tap, borderRadius: t.radius.full,
      backgroundColor: t.c.bgInverse,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    },
    scanTx: { color: t.c.txInverse, fontSize: t.size.md, fontWeight: t.weight.bold, fontFamily: t.fonts.sans },
    go: {
      width: '100%', minHeight: t.space.tap, borderRadius: t.radius.full,
      backgroundColor: 'transparent', borderWidth: t.hairline, borderColor: t.c.bdSecondary,
      alignItems: 'center', justifyContent: 'center',
    },
    goTx: { color: t.c.txPrimary, fontSize: t.size.sm, fontFamily: t.fonts.sans },
    foot: { fontSize: 13, color: t.c.txTertiary, lineHeight: 20, textAlign: 'center', fontFamily: t.fonts.sans },
    mono: { fontFamily: t.fonts.mono },
  });
