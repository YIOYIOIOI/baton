import { create } from 'zustand';
import { getSecret, setSecret } from './secure';

export type LocalePref = 'auto' | 'en' | 'zh';

const KEY = 'baton.locale';

type State = {
  pref: LocalePref;
  ready: boolean;
  boot: () => Promise<void>;
  set: (p: LocalePref) => Promise<void>;
};

export const useLocalePref = create<State>((set) => ({
  pref: 'auto',
  ready: false,

  async boot() {
    try {
      const v = await getSecret(KEY);
      set({ pref: v === 'en' || v === 'zh' ? v : 'auto', ready: true });
    } catch {
      set({ ready: true });
    }
  },

  async set(pref) {
    set({ pref });
    try {
      await setSecret(KEY, pref);
    } catch {
      // Preference loss must not block immediate UI switching.
    }
  },
}));
