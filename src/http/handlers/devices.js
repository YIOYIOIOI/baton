import os from 'node:os';
import { OWNER_ID } from '../../principals.js';
import { encode, toSvg } from '../../qr.js';
import { pickNetworkAddresses, formatHttpUrl } from '../../lan.js';
import { isSecureRequest } from '../auth.js';
import { errorBody } from '../errors.js';
import { appendAuditEvent } from '../../audit.js';

function isOwner(principal) {
  return (principal?.roots ?? null) === null && principal?.id === OWNER_ID;
}

const VALID_HOST_HDR = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?$/i;

function requestOrigin(req, config, interfaces = os.networkInterfaces()) {
  if (config?.publicUrl) return String(config.publicUrl).replace(/\/+$/, '');
  const host = String(req?.headers?.host ?? '').trim();
  const isLocalHost = !host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
  if (!isLocalHost && VALID_HOST_HDR.test(host)) {
    const proto = isSecureRequest(req) ? 'https' : 'http';
    return `${proto}://${host}`;
  }
  const addrs = pickNetworkAddresses(interfaces);
  const ip = addrs.lan ?? addrs.tailscale;
  return ip ? formatHttpUrl(ip, config?.port ?? 3002) : null;
}

/** List paired devices visible to the caller (all for owner, own principal for guests). */
export function listDevices({ auth, principal, deviceId = null }) {
  const scopeId = isOwner(principal) ? null : principal?.id;
  const rows = (auth.listDevices?.({ principalId: scopeId }) ?? []).map((d) => ({
    ...d,
    current: Boolean(deviceId && d.id === deviceId),
  }));
  return { status: 200, body: { devices: rows } };
}

/** Revoke a paired device credential immediately so all subsequent requests return 401. */
export function revokeDevice({ auth, principal, body, deviceId = null, audit = appendAuditEvent }) {
  const targetId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!targetId) {
    return {
      status: 400,
      body: errorBody('missing_device_id', 'Missing target deviceId.', 'Select a device from the Connected Devices list and try again.'),
    };
  }
  const visible = auth.listDevices?.({ principalId: isOwner(principal) ? null : principal?.id }) ?? [];
  const hit = visible.find((d) => d.id === targetId);
  if (!hit) {
    return {
      status: 404,
      body: errorBody('unknown_device', 'Device not found or already revoked.', 'Refresh the Connected Devices list.'),
    };
  }
  auth.revokeDevice?.(hit.id, hit.principalId);
  try {
    audit({ type: 'device_revoked', principal: principal?.id ?? OWNER_ID, targetDeviceId: hit.id, targetPrincipal: hit.principalId });
  } catch {
    // Non-fatal if audit directory is unwritable in an injected unit test
  }
  return { status: 200, body: { ok: true, revoked: true, self: hit.id === deviceId } };
}

/** Owner-only endpoint returning a one-time pairing code + scannable QR SVG for browser-based pairing. */
export function mintPairQr({ auth, principal, config, req, body, interfaces = os.networkInterfaces() }) {
  if (!isOwner(principal)) {
    return {
      status: 403,
      body: errorBody('owner_only', 'Only the host owner can generate pairing QR codes.',
        'Ask the host owner to run `baton pair` or open Settings -> Connection.'),
    };
  }
  const want = typeof body?.for === 'string' && body.for ? body.for : OWNER_ID;
  const ids = auth.principalIds();
  if (!ids.includes(want)) {
    return {
      status: 400,
      body: errorBody('unknown_principal', `Unknown principal: ${want}`,
        `Available identities: ${ids.join(', ')}.`),
    };
  }
  const code = auth.newPairingCode(want);
  const origin = requestOrigin(req, config, interfaces);
  const pairUrl = origin ? `${origin}/pair?c=${code}` : null;
  // QR v10 byte capacity is 213 bytes; fall back to raw pairing code if URL exceeds limit
  const qrPayload = pairUrl && Buffer.byteLength(pairUrl, 'utf8') <= 213 ? pairUrl : code;
  const svg = toSvg(encode(qrPayload), { quiet: 4, scale: 8 });
  const network = {
    publicUrl: config?.publicUrl ?? null,
    ...pickNetworkAddresses(interfaces),
  };
  return {
    status: 200,
    body: { code, for: want, url: pairUrl, svg, expiresInSec: 600, network },
  };
}
