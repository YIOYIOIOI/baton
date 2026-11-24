import { createContext, useContext, useSyncExternalStore } from 'react';
import { ApiError, api } from './api';
import { t } from './i18n';
import { toast } from './ui';

export const CanOpenTerminalCtx = createContext<boolean>(false);

export function useCanOpenTerminal(): boolean {
  return useContext(CanOpenTerminalCtx);
}

const inflight = new Set<string>();
const subs = new Set<() => void>();
const notify = () => subs.forEach((fn) => fn());

/** Subscribe to whether a local terminal launch is currently in flight for `sessionKey`. */
export function useOpeningTerminal(sessionKey: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => inflight.has(sessionKey),
  );
}

/**
 * Trigger the host daemon to open a local terminal window for `sessionKey`.
 * Deduplicates rapid double-clicks for the same session and surfaces actionable feedback.
 */
export async function openSessionTerminal(sessionKey: string): Promise<boolean> {
  if (inflight.has(sessionKey)) return false;
  inflight.add(sessionKey);
  notify();
  try {
    await api.openTerminal(sessionKey);
    toast(t('conv.terminalOpened'));
    return true;
  } catch (err) {
    if (err instanceof ApiError) {
      toast(err.fix ? `${err.message} ${err.fix}` : err.message, 4800);
    } else {
      toast(t('conv.terminalFailed', { msg: err instanceof Error ? err.message : String(err) }), 4800);
    }
    return false;
  } finally {
    inflight.delete(sessionKey);
    notify();
  }
}
