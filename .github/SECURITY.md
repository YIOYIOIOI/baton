# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Baton, **please do not open a public GitHub issue**.

Report it privately using **GitHub Private Vulnerability Reporting** (`Security -> Advisories -> Report a vulnerability`) with:
- A concise description of the issue and potential impact
- Affected component (`src/`, `web/`, `app/`, `sidecars/`) and Baton version
- Minimal reproduction steps or proof of concept

We aim to acknowledge reports within 72 hours and ship a fix and advisory promptly.

---

## Security Architecture & Threat Model

Baton is designed to run on a developer workstation and expose local agent capabilities only to authenticated paired devices.

### 1. Authentication & Device Revocation
- A 256-bit host secret is generated once into `~/.baton/token` (never checked into git, POSIX mode `0600` where applicable).
- Pairing codes are single-use 12-character CSPRNG strings (60-bit alphabet excluding ambiguous characters `0O1I`), rate-limited against brute-force attempts, and expire cleanly.
- Paired sessions receive HMAC-SHA256 derived credentials tied to a unique `deviceId` (HttpOnly cookie for web browsers; Bearer credential in Keychain/SecureStore for mobile/native apps).
- Revoking a device with `POST /api/devices/revoke` records its ID in `~/.baton/revoked.json`, closes its active SSE streams and removes its Web Push subscriptions. `baton revoke-legacy` revokes the shared credential for the selected identity.

### 2. Multi-Principal Workspace Isolation
- Owner credentials represent host-level access. Each entry in the `guests` array in `~/.baton/principals.json` grants access to one workspace through its `root` field.
- All session listings, transcript reads, directory browsing, file reads/uploads, Markdown exports, queued turn drains, and pushes are re-checked against canonical realpaths (`scope.js` + `sessionfs.js`) to stop directory traversal and symlink escapes.
- `--read-only` on CLI acts as an immutable ceiling across all principals, disabling turn execution, session creation, directory creation, and uploads.

### 3. SSRF & Input Boundaries
- Web Push delivery (`src/http/handlers/push.js`) resolves DNS records ahead of connection, blocks private/loopback/link-local/CGNAT IP ranges (including IPv4-mapped IPv6), and disables HTTP redirects (`redirect: 'error'`).
- File uploads validate path containment inside `.baton-uploads` before creating `.gitignore` markers and enforce strict byte limits (`413 Payload Too Large`).
- External Markdown image URLs (`http(s)://...`) in agent responses are **not** auto-fetched as `<img>` tags in the Web UI, preventing IP/token leakage via untrusted URLs.

### 4. Local Exposure Best Practices
- Keep Baton bound to `127.0.0.1` whenever using Cloudflare Tunnel or Tailscale Serve.
- Use `--read-only` when sharing live progress on a host you do not want mutated remotely.
- Never share `~/.baton/token` or commit anything inside `~/.baton/` to source control.
