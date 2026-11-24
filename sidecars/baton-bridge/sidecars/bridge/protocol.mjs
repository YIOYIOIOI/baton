import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PROTOCOL = 2;
export const LOOPBACK = '127.0.0.1';
export const MAX_BODY = 2 * 1024 * 1024;
export const REQUEST_WINDOW_MS = 30_000;
export const isNonce = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const newNonce = () => randomBytes(32).toString('hex');

function mac(instance, purpose, ...fields) {
  return createHmac('sha256', Buffer.from(instance.secret, 'hex'))
    .update(JSON.stringify([PROTOCOL, purpose, instance.instanceId, ...fields])).digest('hex');
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function matchesProof(expected, actual) {
  return isNonce(actual) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function healthProof(instance, challenge) {
  return mac(instance, 'health', instance.pid, instance.port, instance.projectId, challenge);
}

export function requestHeaders(instance, pathname, data, nonce) {
  const timestamp = String(Date.now());
  return {
    'x-baton-time': timestamp,
    'x-baton-nonce': nonce,
    'x-baton-proof': mac(instance, 'request', 'POST', pathname, timestamp, nonce, digest(data)),
  };
}

// Only valid, signed requests consume a replay slot. The caller keeps one cache per instance.
export function verifyRequest(instance, pathname, data, headers, usedNonces) {
  const timestamp = headers['x-baton-time'];
  const nonce = headers['x-baton-nonce'];
  const now = Date.now();
  if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || !isNonce(nonce)
      || Math.abs(now - Number(timestamp)) > REQUEST_WINDOW_MS) return false;
  const expected = mac(instance, 'request', 'POST', pathname, timestamp, nonce, digest(data));
  if (!matchesProof(expected, headers['x-baton-proof'])) return false;
  for (const [seen, expiry] of usedNonces) {
    if (expiry >= now) break;
    usedNonces.delete(seen);
  }
  if (usedNonces.has(nonce) || usedNonces.size >= 4096) return false;
  usedNonces.set(nonce, now + 2 * REQUEST_WINDOW_MS);
  return true;
}

export function responseProof(instance, nonce, status, data) {
  return mac(instance, 'response', nonce, status, digest(data));
}
