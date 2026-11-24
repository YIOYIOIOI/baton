export type CreationStatus = {
  turnId: string;
  status: 'unconfirmed' | 'identified' | 'failed';
  key: string | null;
  sessionId: string | null;
  error?: string;
};

export type CreationReceipt = { turnId: string; statusUrl: string | undefined };

export function watchCreation(receipt: CreationReceipt, read: (url: string, signal: AbortSignal) => Promise<CreationStatus>,
  onIdentified: (key: string) => void, onFailure: (message: string) => void) {
  const request = new AbortController();
  const { turnId, statusUrl } = receipt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function check() {
    if (!statusUrl || statusUrl !== '/api/session-creations/' + encodeURIComponent(turnId)) { onFailure(''); return; }
    try {
      const result = await read(statusUrl, request.signal);
      if (request.signal.aborted) return;
      if (result.turnId === turnId && result.status === 'identified' && result.key) { onIdentified(result.key); return; }
      if (result.turnId === turnId && result.status === 'failed') { onFailure(result.error ?? ''); return; }
    } catch (err) {
      if (request.signal.aborted) return;
      if ([401, 403, 404].includes((err as { status?: number }).status ?? 0)) { onFailure(''); return; }
    }
    timer = setTimeout(check, 2000);
  }
  void check();
  return () => { request.abort(); clearTimeout(timer); };
}
