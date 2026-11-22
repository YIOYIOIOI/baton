import type { Client } from './client';
import { isSendAccepted, type SendResult } from './types';

export async function deliverMessage(
  client: Client, key: string, requestId: string, message: string, refresh: () => Promise<void>,
  accepted: (result: SendResult) => void,
  fork = false, when: 'auto' | 'now' | 'interrupt' = 'auto',
) {
  const result = await client.send(key, message, fork, when, requestId);
  if (!isSendAccepted(result)) throw new Error('send_unconfirmed');
  accepted(result);
  try {
    await refresh();
    return { refreshed: true };
  } catch {
    return { refreshed: false };
  }
}
