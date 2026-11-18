import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import { useTheme } from '@/theme';
import { useConnection } from '@/store/connection';
import { useThemePref } from '@/store/theme';
import { useLocalePref } from '@/store/locale';
import { registerWorker } from '@/store/push';
import { attachBrowserViewport } from '@/layout/browserViewport';

SplashScreen.preventAutoHideAsync();

/**
 * 栈式导航，不是标签页。
 *
 * Baton 只有一条主路径：列表 → 会话。标签页会凭空造出「几个平级的地方」，
 * 而这里并没有几个平级的地方。这也正是避开 App Store 4.2 的关键——
 * 导航由原生栈驱动，不是 Web DOM。
 */
export default function RootLayout() {
  const t = useTheme();
  const boot = useConnection((s) => s.boot);
  const ready = useConnection((s) => s.ready);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    return attachBrowserViewport(window);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    document.documentElement.style.setProperty('--baton-page-background', t.c.bgTertiary);
    document.documentElement.style.colorScheme = t.isDark ? 'dark' : 'light';
  }, [t.c.bgTertiary, t.isDark]);

  useEffect(() => {
    boot();
    // 深浅色偏好也在这儿读回来。读盘是异步的，首帧按「跟随系统」画，
    // 读回来之后再纠正——那一下发生在挂载后，比启动时闪一帧明暗要轻。
    useThemePref.getState().boot();
    useLocalePref.getState().boot();
    // service worker 先注册好。推送要用它，而注册是幂等的——
    // 没开推送时它只是待着，不做任何事（我们没做离线缓存，见 public/sw.js）。
    registerWorker();
  }, [boot]);

  useEffect(() => {
    // 凭据从 Keychain 读回来之前不揭开启动图：否则会先闪一下配对页，
    // 再跳到列表——明明已经配过对的人会以为自己掉线了
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  return (
    <SafeAreaProvider>
      {/*
        键盘那套跑在 UI 线程，需要这个 Provider 在根部。**没有它不会报错**，
        只会让 useKeyboardState 永远返回 0、输入框完全不动——很容易查错方向，
        所以写在这儿并留注。理由见 layout/keyboard.ts 抬头。
      */}
      <KeyboardProvider>
      <Head><title>Baton</title></Head>
      <StatusBar style={t.isDark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.c.bgTertiary } }} />
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
