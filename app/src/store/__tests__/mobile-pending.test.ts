import { Platform } from 'react-native';
import { draftScope } from '../browserSession';
import { beginMobileSend, clearMobileSend, clearMobileSends, readMobileSends } from '../mobilePending';
import { commitSubmittedDraft, persistNextDraft, draftText, selectDraftIdentity, setDraftText, resetDraftIdentity } from '../drafts';

const mockDisk = new Map<string, string>();
let mockFailDraft = false;
jest.mock('expo-file-system', () => ({
  Paths: { document: 'fixture' },
  Directory: class {
    path: string;
    constructor(...parts: (string | { path: string })[]) { this.path = parts.map((p) => typeof p === 'string' ? p : p.path).join('/'); }
    get exists() { return true; }
    list() { return [...mockDisk.keys()].filter((key) => key.startsWith(this.path + '/')).map((key) => ({ name: key.slice(this.path.length + 1) })); }
    delete() { for (const key of mockDisk.keys()) if (key.startsWith(this.path + '/')) mockDisk.delete(key); }
  },
  File: class {
    name: string;
    folder: string;
    constructor(parent: { path: string } | string, name: string) { this.name = name; this.folder = typeof parent === 'string' ? parent : parent.path; }
    get path() { return this.folder + '/' + this.name; }
    get exists() { return mockDisk.has(this.path); }
    create() { mockDisk.set(this.path, ''); }
    write(data: string) { if (mockFailDraft && this.name.startsWith('baton.drafts.')) throw new Error('fixture write failure'); mockDisk.set(this.path, data); }
    textSync() { return mockDisk.get(this.path); }
    rename(name: string) { const old = this.path; this.name = name; mockDisk.set(this.path, mockDisk.get(old)!); mockDisk.delete(old); }
    delete() { mockDisk.delete(this.path); }
  },
}));

test('native remount recovers the immutable request body and mode only for its own server, assignment and session', () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const owner = draftScope('https://one.test', 'reader', 'assignment-a');
  const other = draftScope('https://one.test', 'reader', 'assignment-b');
  const otherHost = draftScope('https://two.test', 'reader', 'assignment-a');
  const text = 'synthetic body\n\n附件（已放在工作目录下）：\n- .baton-uploads/test.txt（2 B）';
  const first = beginMobileSend(owner, 'session', text, false, 'auto');
  // Start with a fresh copy of the native adapter as a re-created app would.
  jest.isolateModules(() => {
    const reopened = jest.requireActual<typeof import('../mobilePending')>('../mobilePending');
    expect(reopened.readMobileSends(owner, 'session')).toEqual([first]);
    expect(reopened.beginMobileSend(owner, 'session', text, false, 'auto').id).toBe(first.id);
  });
  expect(beginMobileSend(owner, 'session', text, false, 'auto').id).toBe(first.id);
  expect(readMobileSends(other, 'session')).toEqual([]);
  expect(readMobileSends(otherHost, 'session')).toEqual([]);
  expect(readMobileSends(owner, 'elsewhere')).toEqual([]);
  const altered = beginMobileSend(owner, 'session', text, false, 'interrupt');
  expect(altered.id).not.toBe(first.id);
  clearMobileSend(owner, 'session', first.id);
  expect(readMobileSends(owner, 'session')).toEqual([altered]);
  const foreign = beginMobileSend(other, 'session', text, false, 'auto');
  const damagedPath = [...mockDisk.keys()].find((p) => p.endsWith(altered.id + '.json'))!;
  mockDisk.set(damagedPath, '{');
  expect(() => beginMobileSend(owner, 'session', text, false, 'auto')).toThrow();
  expect(readMobileSends(other, 'session')).toEqual([foreign]);
  expect(readMobileSends(owner, '../other:session')).toEqual([]);
  clearMobileSends(owner);
  expect(readMobileSends(owner, 'session')).toEqual([]);
  expect(readMobileSends(other, 'session')).toEqual([foreign]);
  jest.restoreAllMocks();
});

test('native consumes an exact durable draft before sending, holds its ID on write failure and keeps new input at fast acknowledgement', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const base = 'https://draft.test';
  const owner = draftScope(base, 'reader');
  const path = 'fixture/' + owner + '.json';
  mockDisk.set(path, JSON.stringify({ chat: ' original ' }));
  await selectDraftIdentity(base, 'reader');
  const op = beginMobileSend(owner, 'chat', 'original', false, 'auto', ' original ');
  mockFailDraft = true;
  expect(() => commitSubmittedDraft(op, ' original ')).toThrow();
  expect(readMobileSends(owner, 'chat')[0].id).toBe(op.id);
  expect(JSON.parse(mockDisk.get(path)!).chat).toBe(' original ');
  mockFailDraft = false;
  commitSubmittedDraft(op, ' original ');
  expect(JSON.parse(mockDisk.get(path)!)).not.toHaveProperty('chat');
  const prepared = readMobileSends(owner, 'chat')[0];
  expect(prepared.draftConsumed).toBe(true);
  setDraftText('chat', ' original '); // A genuinely new, identical draft after the first POST.
  commitSubmittedDraft(prepared, ' original ');
  expect(draftText('chat')).toBe(' original ');
  mockFailDraft = true;
  expect(() => persistNextDraft(owner, 'chat')).toThrow();
  expect(readMobileSends(owner, 'chat')[0].id).toBe(op.id);
  mockFailDraft = false;
  persistNextDraft(owner, 'chat');
  clearMobileSend(owner, 'chat', op.id);
  expect(JSON.parse(mockDisk.get(path)!).chat).toBe(' original ');
  await resetDraftIdentity(true);
  jest.restoreAllMocks();
});
