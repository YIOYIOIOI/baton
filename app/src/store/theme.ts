import { create } from 'zustand';
import { getSecret, setSecret } from './secure';

/**
 * 深浅色的**手动覆盖**。
 *
 * 原来完全跟系统走（`useColorScheme`）。跟系统是好的默认，但它不能是唯一选择：
 * 晚上系统切到深色而你正躺着看白底的长回复，或者反过来，都得能就地改。
 * iOS 自己的 App 也大多给这三档。
 *
 * 三档而不是两档：**「跟随系统」必须是一个可以选回去的档位**。只给明/暗开关
 * 的话，用户一旦碰过它就永远回不到跟随系统，而那才是大多数时候想要的。
 */

export type ThemePref = 'system' | 'light' | 'dark';

/**
 * 借 secure.ts 落盘。
 *
 * 一个主题偏好放进 Keychain 语义上是重了，但它已经把「原生走 SecureStore、
 * 网页走 localStorage」这件事封装好了——为一个开关再引一个原生依赖
 * （AsyncStorage）不划算，而且那会多一样 Expo Go 里要对版本的东西。
 */
const KEY = 'baton.theme';

type State = {
  pref: ThemePref;
  /**
   * 还没从盘上读回来。
   *
   * 读盘是异步的，而首帧要立刻画。这一帧按 `system` 画——**不能凭上次的值猜**，
   * 猜错就是启动时闪一下再跳回去。等读回来了再纠正，那一下发生在挂载后，
   * 比闪一帧明暗要轻。
   */
  ready: boolean;
  boot: () => Promise<void>;
  set: (p: ThemePref) => Promise<void>;
};

export const useThemePref = create<State>((set) => ({
  pref: 'system',
  ready: false,

  async boot() {
    try {
      const v = await getSecret(KEY);
      set({ pref: v === 'light' || v === 'dark' ? v : 'system', ready: true });
    } catch {
      // 读不出来就跟系统走——这是个偏好，不是凭据，丢了不影响能不能用
      set({ ready: true });
    }
  },

  async set(pref) {
    set({ pref });
    try {
      await setSecret(KEY, pref);
    } catch {
      // 存不下也让这次生效：当场的选择比记住它更重要
    }
  },
}));
