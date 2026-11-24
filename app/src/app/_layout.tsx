import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
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
import { rebindExistingPush, registerWorker } from '@/store/push';
import { attachBrowserViewport } from '@/layout/browserViewport';
import { onBrowserLock } from '@/store/browserSession';

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
  const client = useConnection((s) => s.client);
  const connected = useConnection((s) => s.link === 'ok' && s.lastHeardAt > 0);
  const locked = useConnection((s) => s.locked);
  const pendingUnpair = useConnection((s) => s.pendingUnpair);

  useEffect(() => {
    if (!client || !connected || Platform.OS !== 'web') return;
    const current = () => useConnection.getState().client === client && !useConnection.getState().locked;
    void rebindExistingPush(client, current).catch(() => {});
  }, [client, connected]);

  useEffect(() => {
    if (Platform.OS === 'web') return onBrowserLock(() => { void useConnection.getState().boot(); });
  }, []);

  useEffect(() => {
    if (!pendingUnpair) return;
    const retry = () => { void useConnection.getState().retryUnpair(); };
    const timer = setInterval(retry, 15_000);
    const active = AppState.addEventListener('change', (state) => { if (state === 'active') retry(); });
    if (Platform.OS === 'web') window.addEventListener('online', retry);
    return () => {
      clearInterval(timer);
      active.remove();
      if (Platform.OS === 'web') window.removeEventListener('online', retry);
    };
  }, [pendingUnpair]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    return attachBrowserViewport(window);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const root = document.documentElement.style;
    root.setProperty('--baton-page-background', t.c.bgTertiary);
    root.setProperty('--baton-sb', t.c.sb);
    root.setProperty('--baton-ring', t.c.ring);
    root.setProperty('--baton-accent', t.c.coral);
    root.colorScheme = t.isDark ? 'dark' : 'light';
  }, [t.c.bgTertiary, t.c.sb, t.c.ring, t.c.coral, t.isDark]);

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
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.c.bgTertiary } }}>
        <Stack.Protected guard={!locked}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="session/[key]" />
          <Stack.Screen name="chain/[key]" />
          <Stack.Screen name="file/[key]" />
          <Stack.Screen name="files/[key]" />
          <Stack.Screen name="full/[key]" />
          <Stack.Screen name="new" />
        </Stack.Protected>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="pair" />
      </Stack>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
