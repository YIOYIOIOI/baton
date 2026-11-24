/** Shared by the desktop UI and the mobile PWA on the same origin. */
export const LOCK_KEY = 'baton.pairing.lock';
const EPOCH_KEY = 'baton.pairing.epoch';
const BEFORE_PAIR = 'baton.pairing.before';
const PUSH_CACHE = 'baton-push-access-v1';
const PUSH_KEY = '/.baton/push-access';
const ACTIVE_SCOPE = 'baton.drafts.active';
const CHANGE = 'baton-pairing-change';
type Lock = 'pending' | 'locked' | 'pairing' | null;
let memoryLock: Lock = null;
let inFlight: Promise<boolean> | null = null;
let pushWrite: Promise<void> = Promise.resolve();
let granted: string | null = null;
function storedEpoch() {
  try { return localStorage.getItem(EPOCH_KEY) ?? 'initial'; }
  catch { return 'initial'; }
}
let pageEpoch = storedEpoch();

export function getBrowserLock(): Lock {
  if (storedEpoch() !== pageEpoch) return 'locked';
  try {
    const value = localStorage.getItem(LOCK_KEY);
    return value === 'pending' || value === 'locked' || value === 'pairing' ? value : memoryLock;
  } catch { return memoryLock; }
}

export function onBrowserLock(change: () => void) {
  const validate = () => {
    if (storedEpoch() === pageEpoch) {
      if (getBrowserLock() === 'pairing') void recoverBrowserPair();
      return;
    }
    document.documentElement.style.visibility = 'hidden';
    if (window.location.pathname === '/pair') window.location.replace('/');
    else window.location.reload();
  };
  const storage = (e: StorageEvent) => {
    if (e.key === EPOCH_KEY || e.key === null) validate();
    if (e.key !== LOCK_KEY && e.key !== null) return;
    memoryLock = e.newValue === 'pending' || e.newValue === 'locked' || e.newValue === 'pairing' ? e.newValue : null;
    change();
  };
  window.addEventListener(CHANGE, change);
  window.addEventListener('storage', storage);
  window.addEventListener('pageshow', validate);
  window.addEventListener('focus', validate);
  window.addEventListener('online', validate);
  document.addEventListener('visibilitychange', validate);
  if (getBrowserLock() === 'pairing') void recoverBrowserPair();
  return () => {
    window.removeEventListener(CHANGE, change);
    window.removeEventListener('storage', storage);
    window.removeEventListener('pageshow', validate);
    window.removeEventListener('focus', validate);
    window.removeEventListener('online', validate);
    document.removeEventListener('visibilitychange', validate);
  };
}

/** Workers have no localStorage. Only a verified, unlocked page can publish a push grant. */
function writePushAccess(allow: boolean) {
  const epoch = pageEpoch;
  if (allow && granted === epoch) return pushWrite;
  granted = allow ? epoch : null;
  if (!allow) {
    const worker = globalThis.navigator?.serviceWorker;
    const message = { type: 'baton-push-lock', epoch };
    if (worker?.controller) worker.controller.postMessage(message);
    else if (worker?.getRegistration) void worker.getRegistration().then((reg) => reg?.active?.postMessage(message)).catch(() => {});
  }
  const update = async () => {
    if (!globalThis.caches) return;
    const cache = await caches.open(PUSH_CACHE);
    if (allow) {
      if (granted !== epoch || getBrowserLock()) return;
      await cache.put(PUSH_KEY, new Response(epoch));
    } else if ((await (await cache.match(PUSH_KEY))?.text()) === epoch) {
      await cache.delete(PUSH_KEY);
    }
  };
  // A grant checked in one tab must finish before another tab or worker removes it.
  pushWrite = pushWrite.then(() => globalThis.navigator?.locks?.request('baton.push-access', update) ?? update())
    .catch(() => { granted = null; });
  return pushWrite;
}

function setLock(value: Lock) {
  memoryLock = value;
  try {
    if (value) localStorage.setItem(LOCK_KEY, value);
    else localStorage.removeItem(LOCK_KEY);
  } catch { /* The lock still applies to this page. */ }
  window.dispatchEvent(new Event(CHANGE));
}

export function draftScope(origin: string, principal: string, generation?: string) {
  return 'baton.drafts.v2.' + encodeURIComponent(JSON.stringify([new URL(origin).origin, principal, generation ?? null]));
}

export function rememberBrowserScope(scope: string) {
  if (getBrowserLock()) return;
  void writePushAccess(true);
  try {
    localStorage.removeItem('baton.drafts');
    localStorage.setItem(ACTIVE_SCOPE, scope);
  } catch { /* Private mode can disable site storage. */ }
}

export function lockBrowser() {
  if (storedEpoch() !== pageEpoch) return Promise.resolve();
  try {
    const scope = localStorage.getItem(ACTIVE_SCOPE);
    if (scope?.startsWith('baton.drafts.v2.')) {
      localStorage.removeItem(scope);
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(scope + '.send.')) localStorage.removeItem(key);
      }
    }
    localStorage.removeItem(ACTIVE_SCOPE);
    localStorage.removeItem('baton.drafts');
    localStorage.removeItem('baton.token');
  } catch { /* Still lock the page. */ }
  setLock('pending');
  return writePushAccess(false);
}

export function unlockPairedBrowser() { pageEpoch = storedEpoch(); setLock(null); }

function openPairingLock(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('pairing_coordination')); return; }
    const name = 'baton-pairing';
    let waiting = true;
    const fail = (reason: string) => {
      waiting = false;
      clearTimeout(timer);
      reject(new Error(reason));
    };
    // A request behind another tab's blocked delete may receive no events.
    // Bound only the acquisition wait. A live owner's lock never expires.
    const timer = setTimeout(() => fail('pairing_busy'), 2000);
    // This database contains only the mutex. IndexedDB can delete it only
    // after all connections close, including the one a v1 client holds for
    // its entire HTTP operation. Destroying a page also closes its connection.
    const idle = indexedDB.deleteDatabase(name);
    idle.onblocked = () => fail('pairing_busy');
    idle.onerror = () => fail('pairing_coordination');
    idle.onsuccess = () => {
      // A blocked delete stays queued after we report the contention.
      if (!waiting) return;
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('operations');
      open.onerror = () => fail('pairing_coordination');
      open.onsuccess = () => {
        const db = open.result;
        if (!waiting) { db.close(); return; }
        clearTimeout(timer);
        // Concurrent claimants (including older tabs) contend on the same key.
        const tx = db.transaction('operations', 'readwrite');
        tx.objectStore('operations').add(true, 'pairing');
        tx.oncomplete = () => resolve(db);
        tx.onabort = () => { db.close(); fail(tx.error?.name === 'ConstraintError' ? 'pairing_busy' : 'pairing_coordination'); };
      };
    };
  });
}

async function pairingOperation<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request('baton.pairing', operation);
  const db = await openPairingLock().catch((error) => { throw new Error(error?.message === 'pairing_busy' ? 'pairing_busy' : 'pairing_coordination'); });
  try { return await operation(); }
  finally {
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('operations', 'readwrite');
        tx.objectStore('operations').delete('pairing');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(new Error('pairing_coordination'));
      });
    } finally { db.close(); }
  }
}

type BrowserIdentity = { id: string | null; generation?: string; deviceId?: string | null };
type PairEvidence = { epoch: string; before?: BrowserIdentity; issuedDevice?: string | null };

async function currentIdentity(): Promise<BrowserIdentity | undefined> {
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (res.headers.get('x-baton') !== '1') return;
    if (res.status === 401) return { id: null };
    if (!res.ok) return;
    const h = await res.json();
    if (typeof h.principal?.id === 'string') return { id: h.principal.id, generation: h.principal.generation, deviceId: h.deviceId };
  } catch { /* Only a verified same-origin response can release the lock. */ }
}

function advanceEpoch() {
  const epoch = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(EPOCH_KEY, epoch);
  pageEpoch = epoch;
  return epoch;
}

async function finishPair(epoch: string) {
  if (storedEpoch() !== epoch || getBrowserLock() !== 'pairing') throw new Error('pairing_unconfirmed');
  localStorage.removeItem(BEFORE_PAIR);
  advanceEpoch();
  unlockPairedBrowser();
  await writePushAccess(true);
}

async function confirmBrowserPair(epoch: string) {
  const record = JSON.parse(localStorage.getItem(BEFORE_PAIR) ?? 'null') as PairEvidence | null;
  if (!record || record.epoch !== epoch) return false;
  const after = await currentIdentity();
  if (!after?.id) return false;
  if ('issuedDevice' in record) {
    if (!record.issuedDevice || after.deviceId !== record.issuedDevice) return false;
  } else {
    const before = record.before;
    if (!before?.id) return false;
    const newDevice = before.deviceId !== undefined && typeof after.deviceId === 'string' && after.deviceId !== before.deviceId;
    if (before.id === after.id && before.generation === after.generation && !newDevice) return false;
  }
  await finishPair(epoch);
  return true;
}

let recovering: Promise<unknown> | null = null;
let redeeming = false;
function recoverBrowserPair() {
  // A hidden document may freeze before IndexedDB can finish opening.
  if (!recovering && !redeeming && document.visibilityState === 'visible') recovering = pairingOperation(async () => {
    if (getBrowserLock() === 'pairing') await confirmBrowserPair(pageEpoch);
  }).catch(() => {}).finally(() => { recovering = null; });
  return recovering;
}

export function pairBrowser(pair: () => Promise<{ ok: true; deviceId?: string } | null>) {
  if (redeeming) return Promise.reject(new Error('pairing_busy'));
  redeeming = true;
  // A form can be submitted while this page is still checking the old cookie.
  // Finish that check before contending for the cross-tab lock.
  return Promise.resolve(recovering).then(() => pairingOperation(async () => {
    if (getBrowserLock() === 'pending') throw new Error('unpair_pending');
    setLock('pairing');
    const removeOldGrant = writePushAccess(false);
    let epoch: string;
    try {
      if (localStorage.getItem(LOCK_KEY) !== 'pairing') throw new Error();
      epoch = advanceEpoch();
      localStorage.removeItem(BEFORE_PAIR);
    } catch { throw new Error('pairing_unconfirmed'); }
    await removeOldGrant;
    const evidence: PairEvidence = { epoch, before: await currentIdentity() };
    localStorage.setItem(BEFORE_PAIR, JSON.stringify(evidence));
    try {
      const result = await pair();
      if (result?.ok === true && 'deviceId' in result) {
        evidence.issuedDevice = typeof result.deviceId === 'string' ? result.deviceId : null;
        localStorage.setItem(BEFORE_PAIR, JSON.stringify(evidence));
      }
    } catch (error) {
      const status = error instanceof Error && 'status' in error ? Number(error.status) : 0;
      if (status >= 400 && status < 500) {
        localStorage.removeItem(BEFORE_PAIR);
        setLock('locked');
        throw error;
      }
    }
    if (await confirmBrowserPair(epoch)) return;
    throw new Error('pairing_unconfirmed');
  })).catch(async (error: unknown) => {
    if (error instanceof Error && error.message === 'pairing_coordination' && !getBrowserLock()) {
      setLock('pairing');
      await writePushAccess(false);
    }
    throw error;
  }).finally(() => { redeeming = false; });
}

/** A relative URL keeps cookies on the current origin, including after a restart. */
export function retryBrowserUnpair(): Promise<boolean> {
  if (getBrowserLock() !== 'pending') return Promise.resolve(true);
  if (!inFlight) {
    inFlight = pairingOperation(async () => {
      await pushWrite;
      if (getBrowserLock() !== 'pending') return true;
      try {
        const response = await fetch('/api/unpair', {
          method: 'POST', credentials: 'same-origin', redirect: 'error',
        });
        if (!response.ok || response.headers.get('x-baton') !== '1' || (await response.json())?.ok !== true) return false;
        if (getBrowserLock() === 'pending') setLock('locked');
        return true;
      } catch { return false; }
    }).catch(() => false).finally(() => { inFlight = null; });
  }
  return inFlight;
}
