/**
 * Select reachable LAN and Tailscale IPv4 addresses for QR pairing links.
 *
 * Skips loopback, internal, and link-local (169.254.x.x) interfaces as well as
 * public IPv4 addresses (so we never advertise an unproxied public bind).
 */

const PRIVATE_LAN = [
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

// Tailscale / CGNAT IPv4 range: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
const TAILSCALE_CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/**
 * Inspect network interfaces and return the preferred LAN and Tailscale IPv4 addresses.
 * @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]> | null | undefined} interfaces
 * @returns {{ lan: string | null, tailscale: string | null }}
 */
export function pickNetworkAddresses(interfaces) {
  const lanCandidates = [];
  let tailscale = null;
  for (const list of Object.values(interfaces ?? {})) {
    for (const n of list ?? []) {
      const fam = /** @type {string | number | undefined} */ (n?.family);
      const v4 = fam === 'IPv4' || fam === 4;
      if (!v4 || n.internal) continue;
      const addr = String(n.address ?? '');
      if (!addr || addr.startsWith('169.254.')) continue;
      const lanRank = PRIVATE_LAN.findIndex((re) => re.test(addr));
      if (lanRank >= 0) {
        lanCandidates.push({ addr, rank: lanRank });
        continue;
      }
      if (!tailscale && TAILSCALE_CGNAT.test(addr)) {
        tailscale = addr;
      }
    }
  }
  lanCandidates.sort((a, b) => a.rank - b.rank);
  return {
    lan: lanCandidates[0]?.addr ?? null,
    tailscale,
  };
}

/**
 * Format an HTTP URL for a host + port, automatically bracketing literal IPv6 addresses.
 * @param {string} host
 * @param {number | string} port
 * @returns {string}
 */
export function formatHttpUrl(host, port) {
  const raw = String(host ?? '127.0.0.1').trim() || '127.0.0.1';
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const formattedHost = unbracketed.includes(':') ? `[${unbracketed}]` : unbracketed;
  return `http://${formattedHost}:${port}`;
}

/**
 * Pick a single phone-reachable IPv4 address: RFC1918 LAN first, falling back to Tailscale.
 * @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]> | null | undefined} interfaces
 * @returns {string | null}
 */
export function pickLanIp(interfaces) {
  const { lan, tailscale } = pickNetworkAddresses(interfaces);
  return lan ?? tailscale ?? null;
}
