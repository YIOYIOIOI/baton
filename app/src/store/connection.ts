import { create } from 'zustand';
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { BatonError, createClient, type Client } from '../api/client';
import { HEARTBEAT_MS, STALE_AFTER_MS } from '../api/classify';
import type { LinkAxis } from '../api/types';
import {
  clearPendingUnpair, clearToken, loadCredentials, normalizeBaseUrl,
  saveNativeCredential, savePendingUnpair, type NativeCredential,
} from './credentials';
import { draftScope, getBrowserLock, lockBrowser, pairBrowser, retryBrowserUnpair } from './browserSession';
import { setFileIdentity } from './files';
import { resetDraftIdentity, selectDraftIdentity } from './drafts';
import { usePermission } from './permission';

export function pageOrigin(): string | null {
  const origin = globalThis.location?.origin;
  return origin && /^https?:/.test(origin) ? origin : null;
}

type State = {
  ready: boolean;
  baseUrl: string | null;
  token: string | null;
  locked: boolean;
  pendingUnpair: boolean;
  unpairStorageError: boolean;
  link: LinkAxis;
  lastHeardAt: number;
  client: Client | null;
  principalAccess: { scope: string; allowSend: boolean } | null;
  boot: () => Promise<void>;
  pair: (baseUrl: string, code: string) => Promise<void>;
  unpair: () => Promise<void>;
  retryUnpair: () => Promise<boolean>;
  heard: () => void;
  setLink: (l: LinkAxis) => void;
  probe: () => Promise<boolean>;
};

let revision = 0;
let pending: NativeCredential | null = null;
let nativeRetry: Promise<boolean> | null = null;
let prepared: Promise<unknown> = Promise.resolve();
const web = () => Platform.OS === 'web';

function build(baseUrl: string, token: string | null, set: (p: Partial<State>) => void): Client {
  const current = revision;
  const isActive = () => current === revision && (!web() || !getBrowserLock());
  const clearAccess = () => {
    set({ principalAccess: null });
    setFileIdentity(null);
    void resetDraftIdentity();
  };
  const client = createClient({
    baseUrl, token,
    isActive,
    onHealth: (health) => {
      if (!isActive()) return;
      const { principal, allowSend } = health;
      if (!principal?.id) { clearAccess(); return; }
      const scope = draftScope(baseUrl, principal.id, principal.generation);
      set({ principalAccess: { scope, allowSend: allowSend === true } });
      setFileIdentity(scope);
      void selectDraftIdentity(baseUrl, principal.id, principal.generation);
      usePermission.getState().fromHealth(health);
    },
    onHeard: () => { if (revision === current) set({ lastHeardAt: Date.now() }); },
    onLink: (link) => { if (revision === current) set({ link }); },
  });
  // Boot, foreground, the session stream and manual refresh can all wake together.
  let checking: ReturnType<Client['health']> | null = null;
  return {
    ...client,
    health() {
      if (!checking) {
        checking = client.health().catch((error) => {
          if (isActive() && error instanceof BatonError && error.status === 401) clearAccess();
          throw error;
        }).finally(() => { checking = null; });
      }
      return checking;
    },
  };
}

export function canSendFor(client: Client, scope: string | null): boolean {
  const current = useConnection.getState();
  return current.client === client && !current.locked && (!web() || !getBrowserLock())
    && current.principalAccess?.allowSend === true && current.principalAccess.scope === scope;
}

export const useConnection = create<State>((set, get) => ({
  ready: false, baseUrl: null, token: null, locked: false, pendingUnpair: false, unpairStorageError: false,
  link: 'ok', lastHeardAt: 0, client: null, principalAccess: null,

  async boot() {
    const current = ++revision;
    set({ principalAccess: null });
    setFileIdentity(null);
    try {
      const saved = await loadCredentials();
      const baseUrl = web() ? pageOrigin() : saved.baseUrl;
      const lock = web() ? getBrowserLock() : null;
      const storedPending = saved.pending ?? null;
      if (current !== revision) return;
      pending = storedPending;
      const locked = !!(lock || pending || (!web() && !saved.token));
      if (locked) void resetDraftIdentity();
      const client = baseUrl && !locked ? build(baseUrl, saved.token, set) : null;
      set({ ready: true, baseUrl, locked, token: locked ? null : saved.token, unpairStorageError: !!saved.storageError,
        client, pendingUnpair: lock === 'pending' || !!pending });
      if (get().pendingUnpair) void get().retryUnpair();
      else if (client) void client.health().catch(() => {});
    } catch {
      if (current === revision) set({ ready: true, locked: true, token: null, client: null });
    }
  },

  async probe() {
    const client = get().client;
    if (!client || get().locked) return false;
    try { await client.health(); return !get().locked && get().client === client; }
    catch { return false; }
  },

  async pair(rawUrl, code) {
    const baseUrl = normalizeBaseUrl(rawUrl);
    if (!baseUrl || (web() && baseUrl !== pageOrigin())) throw new Error('invalid_baton_origin');
    if (get().pendingUnpair || (web() && getBrowserLock() === 'pending')) throw new Error('unpair_pending');
    const probe = createClient({ baseUrl, token: null });
    let token: string | null = null;
    if (web()) {
      await pairBrowser(() => probe.pairWithCookie(code));
    } else {
      token = await probe.pairForBearer(code);
      await saveNativeCredential(baseUrl, token);
    }
    ++revision;
    setFileIdentity(null);
    void resetDraftIdentity();
    const client = build(baseUrl, token, set);
    set({ baseUrl, token, client, principalAccess: null, locked: false, pendingUnpair: false, unpairStorageError: false, ready: true });
    void client.health().catch(() => {});
  },

  async unpair() {
    const { baseUrl, token } = get();
    ++revision;
    setFileIdentity(null);
    set({ locked: true, token: null, client: null, principalAccess: null, pendingUnpair: true });
    const clearDrafts = resetDraftIdentity(true);
    if (web()) {
      await lockBrowser();
    } else if (baseUrl && token) {
      pending = { baseUrl, token };
      prepared = savePendingUnpair(pending).catch(() => { set({ unpairStorageError: true }); });
      await prepared;
    }
    await clearDrafts;
    void get().retryUnpair();
  },

  async retryUnpair() {
    if (web()) {
      const ok = await retryBrowserUnpair();
      set({ pendingUnpair: getBrowserLock() === 'pending' });
      return ok;
    }
    if (nativeRetry) return nativeRetry;
    const target = pending;
    if (!target) { set({ pendingUnpair: false }); return true; }
    nativeRetry = (async () => {
      try {
        await prepared;
        if (get().unpairStorageError) {
          try { await savePendingUnpair(target); set({ unpairStorageError: false }); }
          catch { /* Keep retrying the original server using the in-memory credential. */ }
        }
        const response = await expoFetch(`${target.baseUrl}/api/unpair`, {
          method: 'POST', credentials: 'omit', redirect: 'error',
          headers: { Authorization: `Bearer ${target.token}` },
        });
        if (!response.ok || response.headers.get('x-baton') !== '1' || (await response.json())?.ok !== true) return false;
        await clearToken();
        await clearPendingUnpair();
        pending = null;
        set({ pendingUnpair: false, unpairStorageError: false });
        return true;
      } catch { return false; }
    })().finally(() => { nativeRetry = null; });
    return nativeRetry;
  },

  heard: () => set({ lastHeardAt: Date.now() }),
  setLink: (link) => set({ link }),
}));

export { HEARTBEAT_MS, STALE_AFTER_MS };
