import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { useConnection } from '../connection';
import { draftScope, getBrowserLock, pairBrowser, unlockPairedBrowser } from '../browserSession';
import { resetDraftIdentity } from '../drafts';

const mockDisk = new Map<string, string>();
const mockFailedWrites = new Set<string>();
const mockFiles = new Set<string>();
jest.mock('expo-file-system', () => ({
  Paths: { document: 'isolated' },
  File: class {
    private name: string;
    constructor(_dir: string, name: string) { this.name = name; }
    get exists() { return mockFiles.has(this.name); }
    create() { mockFiles.add(this.name); }
    delete() { mockFiles.delete(this.name); }
  },
}));
const local = {
  get length() { return mockDisk.size; },
  key: (i: number) => [...mockDisk.keys()][i] ?? null,
  getItem: (key: string) => mockDisk.get(key) ?? null,
  setItem: (key: string, value: string) => { mockDisk.set(key, value); },
  removeItem: (key: string) => { mockDisk.delete(key); },
};
jest.mock('../secure', () => ({
  getSecret: async (key: string) => mockDisk.get(key) ?? null,
  setSecret: async (key: string, value: string) => {
    if (mockFailedWrites.has(key)) throw new Error('KEYCHAIN_UNAVAILABLE');
    mockDisk.set(key, value);
  },
  deleteSecret: async (key: string) => { mockDisk.delete(key); },
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
const transport = expoFetch as jest.Mock;
const browserFetch = jest.fn();
const origin = 'https://current.example.test';
const remote = 'https://native.example.test:9443';
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => '1' }, json: async () => body });

beforeEach(async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, run: () => unknown) => run() } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: browserFetch });
  if (!window.dispatchEvent) Object.defineProperty(window, 'dispatchEvent', { configurable: true, value: jest.fn() });
  await resetDraftIdentity();
  mockDisk.clear();
  mockFiles.clear();
  mockFailedWrites.clear();
  unlockPairedBrowser();
  transport.mockReset();
  browserFetch.mockReset();
});
afterEach(() => jest.restoreAllMocks());

test('PWA discards the old web bearer and uses only the cookie on its own origin', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  mockDisk.set('baton.token', 'synthetic-legacy');
  mockDisk.set('baton.baseUrl', remote);
  browserFetch.mockResolvedValueOnce({ ...ok({}), ok: false, status: 401 }).mockResolvedValue(ok({ principal: { id: 'reader' }, deviceId: 'current-device' }));
  transport.mockImplementation(async (url: string) => ok(url.endsWith('/pair') ? { ok: true, deviceId: 'current-device' } : { principal: { id: 'reader' } }));
  await useConnection.getState().boot();
  await useConnection.getState().pair(origin, 'ABCD2345EFGH');
  expect(mockDisk.has('baton.token')).toBe(false);
  expect(useConnection.getState().token).toBeNull();
  expect(transport.mock.calls.every(([url, init]) => new URL(url).origin === origin
    && init.credentials === 'same-origin' && !init.headers.Authorization)).toBe(true);
  expect(JSON.parse(transport.mock.calls.find(([url]) => url.endsWith('/pair'))![1].body)).toEqual({ code: 'ABCD2345EFGH' });
  await expect(useConnection.getState().pair(remote, 'ABCD2345EFGH')).rejects.toThrow();
});

test('a complete pairing receipt unlocks only the cookie issued for this device; older servers need provable change', async () => {
  const reader = (deviceId?: string) => ok({ principal: { id: 'reader' }, deviceId });
  browserFetch.mockResolvedValueOnce(ok({ principal: { id: 'owner' }, deviceId: 'original' })).mockResolvedValue(reader('other-device'));
  await expect(pairBrowser(async () => ({ ok: true, deviceId: 'issued-device' }))).rejects.toThrow('pairing_unconfirmed');
  expect(getBrowserLock()).toBe('pairing');
  browserFetch.mockResolvedValue(reader('issued-device'));
  await pairBrowser(async () => ({ ok: true, deviceId: 'issued-device' }));
  expect(getBrowserLock()).toBeNull();
  browserFetch.mockResolvedValue(reader());
  await expect(pairBrowser(async () => ({ ok: true }))).rejects.toThrow('pairing_unconfirmed');
  expect(getBrowserLock()).toBe('pairing');
  browserFetch.mockResolvedValueOnce(ok({ principal: { id: 'owner' } })).mockResolvedValue(reader());
  await pairBrowser(async () => ({ ok: true }));
  expect(getBrowserLock()).toBeNull();
});

test('PWA locks, clears the active draft, and retries only with its own cookie after a restart', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  transport.mockResolvedValue(ok({ principal: { id: 'reader' } }));
  await useConnection.getState().boot();
  await useConnection.getState().client!.health();
  const scope = draftScope(origin, 'reader');
  mockDisk.set(scope, JSON.stringify({ new: 'unshared text' }));
  mockDisk.set(scope + '.send.session', 'unconfirmed fixture');
  const other = draftScope(origin, 'reader', 'other-generation') + '.send.session';
  mockDisk.set(other, 'separate fixture');
  browserFetch.mockRejectedValue(new Error('offline'));
  const logout = useConnection.getState().unpair();
  expect(useConnection.getState().locked).toBe(true);
  expect(useConnection.getState().client).toBeNull();
  await logout;
  await useConnection.getState().retryUnpair();
  expect(getBrowserLock()).toBe('pending');
  expect(mockDisk.has(scope)).toBe(false);
  expect(mockDisk.has(scope + '.send.session')).toBe(false);
  expect(mockDisk.has(other)).toBe(true);
  await useConnection.getState().boot();
  expect(useConnection.getState().client).toBeNull();
  expect(await useConnection.getState().probe()).toBe(false);
  await expect(useConnection.getState().pair(origin, 'ABCD2345EFGH')).rejects.toThrow();
  await useConnection.getState().retryUnpair();
  browserFetch.mockResolvedValue(ok({ ok: true, revoked: 'device' }));
  expect(await useConnection.getState().retryUnpair()).toBe(true);
  expect(getBrowserLock()).toBe('locked');
  expect(browserFetch.mock.calls.every(([url, init]) => url === '/api/unpair'
    && init.credentials === 'same-origin' && init.redirect === 'error' && !init.headers)).toBe(true);
});

test('an old device recovering from a 401 cannot confirm a missing or rejected pairing receipt', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const denied = { ...ok(null), ok: false, status: 401 };
  const owner = ok({ principal: { id: 'owner' }, deviceId: 'original-device' });
  browserFetch.mockResolvedValueOnce(denied).mockResolvedValue(owner);
  await expect(pairBrowser(async () => null)).rejects.toThrow('pairing_unconfirmed');
  expect(getBrowserLock()).toBe('pairing');
  const rejection = Object.assign(new Error('expired code'), { status: 400 });
  browserFetch.mockResolvedValueOnce(denied);
  await expect(pairBrowser(async () => { throw rejection; })).rejects.toBe(rejection);
  expect(getBrowserLock()).toBe('locked');
  expect(mockDisk.has('baton.pairing.before')).toBe(false);
});

test('a lost pairing receipt is recovered only for a verified change of authenticated device or principal', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const health = (deviceId?: string) => ok({ principal: { id: 'reader', generation: 'assignment' }, deviceId });
  browserFetch.mockResolvedValueOnce(health('previous-device')).mockResolvedValueOnce(health('new-device'));
  await pairBrowser(async () => { expect(getBrowserLock()).toBe('pairing'); return null; });
  expect(getBrowserLock()).toBeNull();
  expect(browserFetch.mock.calls.every(([url, init]) => url === '/api/health' && init.credentials === 'same-origin' && init.redirect === 'error')).toBe(true);
  browserFetch.mockResolvedValue(health('same-device'));
  await expect(pairBrowser(async () => null)).rejects.toThrow('pairing_unconfirmed');
  expect(getBrowserLock()).toBe('pairing');
  browserFetch.mockResolvedValue(health());
  await expect(pairBrowser(async () => null)).rejects.toThrow('pairing_unconfirmed');
  expect(getBrowserLock()).toBe('pairing');
  browserFetch.mockRejectedValue(new Error('offline'));
  await expect(pairBrowser(async () => null)).rejects.toThrow('pairing_unconfirmed');
  expect(getBrowserLock()).toBe('pairing');
});

test('native retries revocation with the saved device credential and the original server despite a changed base URL', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  transport.mockImplementation(async (url: string) => {
    if (url.endsWith('/unpair')) throw new Error('offline');
    return ok(url.endsWith('/pair') ? { ok: true, bearer: 'synthetic-device' } : { principal: { id: 'reader' } });
  });
  await useConnection.getState().boot();
  await useConnection.getState().pair(remote, 'ABCD2345EFGH');
  expect(useConnection.getState().token).toBe('synthetic-device');
  await useConnection.getState().unpair();
  await useConnection.getState().retryUnpair();
  expect(JSON.parse(mockDisk.get('baton.connection')!).state).toBe('pending');
  mockDisk.set('baton.baseUrl', origin);
  await useConnection.getState().boot();
  await useConnection.getState().retryUnpair();
  expect(useConnection.getState().client).toBeNull();
  transport.mockResolvedValue(ok({ ok: true, revoked: 'device' }));
  expect(await useConnection.getState().retryUnpair()).toBe(true);
  expect(mockDisk.has('baton.pendingUnpair')).toBe(false);
  const calls = transport.mock.calls.filter(([url]) => url.endsWith('/unpair'));
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every(([url, init]) => url === remote + '/api/unpair' && init.credentials === 'omit'
    && init.redirect === 'error' && init.headers.Authorization === 'Bearer synthetic-device')).toBe(true);
});

test('a partial Keychain failure keeps the device locked on restart, and a completely unwritable Keychain reports lost persistence', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  transport.mockImplementation(async (url: string) => {
    if (url.endsWith('/unpair')) throw new Error('offline');
    return ok(url.endsWith('/pair') ? { ok: true, bearer: 'mock-device' } : { principal: { id: 'reader' } });
  });
  await useConnection.getState().boot();
  await useConnection.getState().pair(remote, 'ABCD2345EFGH');
  mockFailedWrites.add('baton.connection');
  await useConnection.getState().unpair();
  await useConnection.getState().retryUnpair();
  await useConnection.getState().boot();
  expect(useConnection.getState()).toMatchObject({ locked: true, pendingUnpair: true, client: null, token: null });
  await useConnection.getState().retryUnpair();
  transport.mockResolvedValue(ok({ ok: true }));
  await useConnection.getState().retryUnpair();
  mockDisk.set('baton.connection', JSON.stringify({ baseUrl: remote, token: 'second-mock-device' }));
  await useConnection.getState().boot();
  mockFailedWrites.add('baton.pendingUnpair');
  transport.mockRejectedValue(new Error('offline'));
  await useConnection.getState().unpair();
  await useConnection.getState().retryUnpair();
  expect(useConnection.getState()).toMatchObject({ locked: true, unpairStorageError: true, client: null });
  expect(mockFiles.has('baton-unpair-pending')).toBe(true);
  await useConnection.getState().boot();
  expect(useConnection.getState()).toMatchObject({ locked: true, token: null, client: null, pendingUnpair: true });
  await useConnection.getState().retryUnpair();
  transport.mockResolvedValue(ok({ ok: true }));
  expect(await useConnection.getState().retryUnpair()).toBe(true);
  expect(mockFiles.has('baton-unpair-pending')).toBe(false);
});
