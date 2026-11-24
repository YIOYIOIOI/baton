export type SendMode = 'auto' | 'interrupt';
export type SendIntent = { id: string; message: string; fork: boolean; when: SendMode; startedAt?: number };

/** A changed payload is a new action. A lost response retries the exact action. */
export function sendIntent(previous: SendIntent | null, message: string, fork: boolean, when: SendMode): SendIntent {
  if (previous?.message === message && previous.fork === fork && previous.when === when) return previous;
  const id = globalThis.crypto?.randomUUID?.() ?? `w${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { id, message, fork, when, startedAt: Date.now() };
}
