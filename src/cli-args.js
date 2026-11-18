export const USAGE = [
  'Baton — Remote monitor & controller for Claude Code, Codex, and Antigravity',
  '',
  'Usage:',
  '  baton [start] [options]   Start the Baton daemon (default command)',
  '  baton pair [--for <id>]   Mint a 12-char pairing code & SVG QR from a running daemon',
  '  baton doctor [--json]     Diagnose Node, agent CLIs, auth, build bundles, and network IPs',
  '  baton tunnel [--port N]   Start a Cloudflare Quick Tunnel (trycloudflare.com)',
  '  baton --help | -h         Show this help',
  '  baton --version | -v      Show version',
  '',
  'Start options:',
  '  --port <n>                Listen port (overrides ~/.baton/config.json)',
  '  --host <addr>             Listen host (default 127.0.0.1)',
  '  --quick-tunnel, --tunnel  Expose this session temporarily via Cloudflare Quick Tunnel',
  '  --read-only               Disable send/create/upload endpoints for this run',
].join('\n');

const START_FLAGS = new Set(['--port', '--host', '--quick-tunnel', '--tunnel', '--read-only']);

/**
 * @param {string[]} argv
 * @param {number} idx
 * @param {string} flag
 * @returns {{ ok: false, error: string, fix: string } | { ok: true, value: string }}
 */
function readVal(argv, idx, flag) {
  const next = argv[idx + 1];
  if (!next || next.startsWith('-')) {
    return { ok: false, error: `Missing value for ${flag}.`, fix: USAGE };
  }
  return { ok: true, value: next };
}

/**
 * Parse CLI arguments for the `baton` command. Empty argv starts the daemon cleanly.
 * @param {string[]} argv
 * @returns {
 *   | { ok: false, error: string, fix: string }
 *   | { ok: true, cmd: 'help' | 'version' }
 *   | { ok: true, cmd: 'doctor', json: boolean }
 *   | { ok: true, cmd: 'pair', for: string | null, host?: string, port?: number }
 *   | { ok: true, cmd: 'tunnel', port: number | null }
 *   | { ok: true, cmd: 'start', host: string | null, port: number | null, quickTunnel: boolean, readOnly: boolean }
 * }
 */
export function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.length === 0) {
    return { ok: true, cmd: 'start', host: null, port: null, quickTunnel: false, readOnly: false };
  }

  const first = args[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    return { ok: true, cmd: 'help' };
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    return { ok: true, cmd: 'version' };
  }

  if (first === 'pair') {
    let target = null;
    let host = null;
    let port = null;
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === '--for') {
        const v = readVal(args, i, '--for');
        if (!v.ok) return v;
        target = v.value;
        i += 1;
      } else if (args[i] === '--host') {
        const v = readVal(args, i, '--host');
        if (!v.ok) return v;
        host = v.value;
        i += 1;
      } else if (args[i] === '--port') {
        const v = readVal(args, i, '--port');
        if (!v.ok) return v;
        const p = Number(v.value);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          return { ok: false, error: `Invalid port: ${v.value}`, fix: 'Pass an integer port between 1 and 65535.' };
        }
        port = p;
        i += 1;
      } else {
        return { ok: false, error: `Unknown pair option: ${args[i]}`, fix: 'Use `baton pair [--for <id>] [--port N] [--host addr]`.' };
      }
    }
    return {
      ok: true,
      cmd: 'pair',
      for: target,
      ...(host ? { host } : {}),
      ...(port !== null ? { port } : {}),
    };
  }

  if (first === 'doctor') {
    let json = false;
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === '--json') json = true;
      else return { ok: false, error: `Unknown doctor option: ${args[i]}`, fix: 'Use `baton doctor` or `baton doctor --json`.' };
    }
    return { ok: true, cmd: 'doctor', json };
  }

  if (first === 'tunnel') {
    let port = null;
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === '--port') {
        const v = readVal(args, i, '--port');
        if (!v.ok) return v;
        const p = Number(v.value);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          return { ok: false, error: `Invalid port: ${v.value}`, fix: 'Pass an integer port between 1 and 65535.' };
        }
        port = p;
        i += 1;
      } else {
        return { ok: false, error: `Unknown tunnel option: ${args[i]}`, fix: 'Use `baton tunnel [--port <n>]`.' };
      }
    }
    return { ok: true, cmd: 'tunnel', port };
  }

  let idx = 0;
  if (first === 'start') {
    idx = 1;
  } else if (!first.startsWith('-')) {
    return { ok: false, error: `Unknown command: ${first}`, fix: USAGE };
  } else if (!START_FLAGS.has(first)) {
    return { ok: false, error: `Unknown option: ${first}`, fix: USAGE };
  }

  let host = null;
  let port = null;
  let quickTunnel = false;
  let readOnly = false;
  for (let i = idx; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--quick-tunnel' || a === '--tunnel') {
      quickTunnel = true;
    } else if (a === '--read-only') {
      readOnly = true;
    } else if (a === '--host') {
      const v = readVal(args, i, '--host');
      if (!v.ok) return v;
      host = v.value;
      i += 1;
    } else if (a === '--port') {
      const v = readVal(args, i, '--port');
      if (!v.ok) return v;
      const p = Number(v.value);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return { ok: false, error: `Invalid port: ${v.value}`, fix: 'Pass an integer port between 1 and 65535.' };
      }
      port = p;
      i += 1;
    } else {
      return { ok: false, error: `Unknown option: ${a}`, fix: USAGE };
    }
  }
  return { ok: true, cmd: 'start', host, port, quickTunnel, readOnly };
}
