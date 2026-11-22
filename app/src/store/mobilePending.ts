import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { getBrowserLock } from './browserSession';

export type MobileSend = { scope: string; session: string; id: string; text: string; fork: boolean; when: 'auto' | 'now' | 'interrupt'; startedAt?: number; sourceDraft?: string; draftConsumed?: boolean };
function pathParts(value: string) {
  // A reversible directory name with bounded components, safe even for URI separators and '..'.
  const encoded = encodeURIComponent(value).replace(/[!'()*~.]/g, (c) => '%' + c.charCodeAt(0).toString(16)).replaceAll('%', '~');
  return (encoded.match(/.{1,100}/g) ?? ['']).map((s) => 'x-' + s);
}
const ownerDirectory = (scope: string) => new Directory(Paths.document, 'baton-pending-sends', ...pathParts(scope), 'sessions');
const directory = (scope: string, session: string) => new Directory(ownerDirectory(scope), ...pathParts(session), 'records');
const webPrefix = (scope: string) => scope + '.send.mobile.';
const webKey = (scope: string, session: string, id: string) => webPrefix(scope) + encodeURIComponent(session) + '/' + id;

export function readMobileSends(scope: string, session: string): MobileSend[] {
  const raw: string[] = [];
  if (Platform.OS === 'web') {
    if (getBrowserLock()) return [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(webKey(scope, session, ''))) raw.push(localStorage.getItem(key) ?? 'null');
    }
  } else {
    const folder = directory(scope, session);
    if (folder.exists) for (const item of folder.list()) {
      if (item.name.endsWith('.json')) raw.push(new File(folder, item.name).textSync());
    }
  }
  return raw.map((s) => {
    const item = JSON.parse(s) as MobileSend | null;
    if (!item || item.scope !== scope || item.session !== session || typeof item.text !== 'string'
      || typeof item.id !== 'string' || !/^[a-z0-9-]+$/i.test(item.id) || typeof item.fork !== 'boolean' || !['auto', 'now', 'interrupt'].includes(item.when)) throw new Error('send_storage');
    if (Platform.OS !== 'web' && new File(directory(scope, session), item.id + '.ready').exists) item.draftConsumed = true;
    return item;
  });
}

/** Persist the exact wire payload before sending, including uploaded paths in text. */
export function beginMobileSend(scope: string | null, session: string, text: string, fork: boolean, when: MobileSend['when'], sourceDraft?: string): MobileSend {
  if (!scope || (Platform.OS === 'web' && getBrowserLock())) throw new Error('send_storage');
  const previous = readMobileSends(scope, session).find((r) => r.text === text && r.when === when && r.fork === fork);
  if (previous) return previous;
  const id = globalThis.crypto?.randomUUID?.() ?? `p${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const entry = { scope, session, id, text, fork, when, sourceDraft, startedAt: Date.now() };
  const json = JSON.stringify(entry);
  if (Platform.OS === 'web') localStorage.setItem(webKey(scope, session, id), json);
  else {
    const folder = directory(scope, session);
    if (!folder.exists) folder.create({ idempotent: true, intermediates: true });
    // A crash before the rename leaves no sendable record and no POST. A crash
    // after it lets the next process replay only the original request ID.
    const file = new File(folder, id + '.tmp');
    file.create({ overwrite: true });
    file.write(json);
    file.rename(id + '.json');
  }
  return entry;
}

export function markMobileDraftConsumed(entry: MobileSend) {
  if (entry.draftConsumed) return;
  if (Platform.OS === 'web') localStorage.setItem(webKey(entry.scope, entry.session, entry.id), JSON.stringify({ ...entry, draftConsumed: true }));
  else {
    const receipt = new File(directory(entry.scope, entry.session), entry.id + '.ready');
    if (!receipt.exists) receipt.create();
  }
}

export function clearMobileSend(scope: string, session: string, id: string) {
  if (!/^[a-z0-9-]+$/i.test(id)) return;
  if (Platform.OS === 'web') localStorage.removeItem(webKey(scope, session, id));
  else {
    const folder = directory(scope, session);
    const file = new File(folder, id + '.json');
    if (file.exists) file.delete();
    const marker = new File(folder, id + '.ready');
    if (marker.exists) marker.delete();
  }
}

export function clearMobileSends(scope: string) {
  if (Platform.OS === 'web') {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(webPrefix(scope))) localStorage.removeItem(key);
    }
  } else {
    const folder = ownerDirectory(scope);
    if (folder.exists) folder.delete();
  }
}
