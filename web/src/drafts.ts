import { createContext, useCallback, useContext, useState } from 'react';
import { getBrowserLock } from '../../app/src/store/browserSession';
import type { Attachment } from './attach';
import type { SendIntent } from './sendIntent';

export const DraftScope = createContext<string | null>(null);
export const NEW_SESSION_DRAFT = 'new';

function read(scope: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(scope) ?? '{}') ?? {}; }
  catch { return {}; }
}

export type PendingSend = SendIntent & { draft: string; attachments: Attachment[] };

function deliveryKey(scope: string, session: string) { return scope + '.send.' + encodeURIComponent(session); }

export function readPendingSend(scope: string | null, session: string): PendingSend | null {
  if (!scope || getBrowserLock()) return null;
  try {
    const value: PendingSend | null = JSON.parse(localStorage.getItem(deliveryKey(scope, session)) ?? 'null');
    if (!value || typeof value.id !== 'string' || typeof value.message !== 'string' || typeof value.draft !== 'string'
      || typeof value.fork !== 'boolean' || !['auto', 'interrupt'].includes(value.when) || !Array.isArray(value.attachments)) return null;
    return value;
  } catch { return null; }
}

export function savePendingSend(scope: string | null, session: string, value: PendingSend) {
  if (!scope || getBrowserLock()) return false;
  try { localStorage.setItem(deliveryKey(scope, session), JSON.stringify(value)); return true; }
  catch { return false; }
}

export function clearPendingSend(scope: string | null, session: string, id: string) {
  if (scope && readPendingSend(scope, session)?.id === id) localStorage.removeItem(deliveryKey(scope, session));
}

export function useDraft(key: string, fallback = '') {
  const scope = useContext(DraftScope);
  const [value, setValue] = useState(() => {
    const text = scope && !getBrowserLock() ? read(scope)[key] : '';
    return typeof text === 'string' ? text : fallback;
  });
  const set = useCallback((text: string) => {
    if (getBrowserLock()) return;
    setValue(text);
    if (!scope) return;
    try {
      const drafts = read(scope);
      if (text) drafts[key] = text;
      else delete drafts[key];
      localStorage.setItem(scope, JSON.stringify(drafts));
    } catch { /* Keep the draft in this tab if storage is unavailable. */ }
  }, [scope, key]);
  return [value, set] as const;
}
