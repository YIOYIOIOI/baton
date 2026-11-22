# Installation & Operations Guide

## 1. Requirements

- **Node.js `>= 24.0.0`** (uses built-in `node:sqlite`, `WebSocket`, and native TypeScript type stripping)
- One or more local coding agent CLIs installed and authenticated on the host workstation:
  - **Claude Code** (`claude` in `PATH`, credentials in `~/.claude/.credentials.json`, env, or macOS Keychain)
  - **OpenAI Codex** (`codex` in `PATH`, sessions in `~/.codex`)
  - **Gemini Antigravity** (`agy` in `PATH`, Antigravity IDE / local bridge)
- Optional: `cloudflared` (for Cloudflare Quick Tunnel or Named Tunnel remote HTTPS access) or **Tailscale** (for private mesh access).

Session file downloads and attachment previews require the host to report the final path of an open file. Windows looks for PowerShell 7 under the host's 64-bit Program Files directory, usually `C:\Program Files\PowerShell\7\pwsh.exe`. For another host installation, set `BATON_PWSH7` to the canonical absolute path of a trusted `pwsh.exe` before starting Baton. `baton doctor` reports the selected path and its availability. NTFS downloads can share a verifier. Volumes such as exFAT or ReFS use a separate check on the original handle, which can take longer. Baton returns HTTP 503 if this verification is unavailable. Linux needs `/proc/self/fd`. macOS uses the system `/usr/bin/perl` to query the file handle.

---

## 2. Option A — Install Prebuilt Release (Fastest)

The GitHub Release archive ships the Node daemon plus prebuilt `web/dist/` and `app/dist/` bundles — no source compilation step is required:

```bash
npm install -g https://github.com/YIOYIOIOI/baton/releases/download/v0.2.0/baton-0.2.0.tgz
baton doctor
baton start
```

Or run temporarily with an ephemeral **Cloudflare Quick Tunnel**:

```bash
baton start --tunnel
```

---

## 3. Option B — Build from Source

```bash
git clone https://github.com/YIOYIOIOI/baton.git
cd baton

# Installs root, web/, and app/ dependencies and builds web/dist/ + app/dist/
npm run setup
```

Verify environment readiness without starting the daemon:

```bash
npm run doctor
```

Start the daemon:

```bash
npm start
```

---

## 4. Network Modes (LAN, Tailscale, Cloudflare)

### A. Localhost Only (Safest Default)

Default configuration listens on `127.0.0.1:3002`. Only processes on the workstation (and reverse tunnels running on the workstation) can connect.

### B. Private Mesh via Tailscale (`100.64.0.0/10`)

1. Start Baton bound to your Tailscale IP (check `baton doctor` to inspect detected Tailscale addresses) or configure `tailscale serve`:
   ```bash
   baton start --host 100.x.y.z --port 3002
   ```
2. Or use `tailscale serve --bg 3002` so Baton stays bound to `127.0.0.1:3002` behind Tailscale HTTPS.
3. Baton sets cookie `Secure` attributes dynamically based on transport security (`isSecureRequest`), so direct LAN/Tailscale HTTP works while HTTPS tunnels retain strict `Secure` cookies.

### C. Ephemeral Public Access (Cloudflare Quick Tunnel)

```bash
baton start --tunnel
```

Spawns `cloudflared tunnel --url http://127.0.0.1:3002` and prints a temporary `https://*.trycloudflare.com` pairing URL and QR code.

### D. Persistent Domain (Cloudflare Named Tunnel)

Configure `~/.cloudflared/config.yml` on your host so traffic to your custom hostname forwards to `http://127.0.0.1:3002`, and ensure `cloudflared` sends standard forwarding headers (`X-Forwarded-Proto: https`). See [Cloudflare Tunnel Guide](setup/cloudflare-tunnel.md) for a complete walkthrough.

---

## 5. Background Autostart

Baton includes a cross-platform autostart installer (`scripts/install-autostart.mjs`):

```bash
# Preview the generated startup definition without modifying your system:
npm run autostart -- --dry-run

# Install autostart for the current platform:
# - macOS: ~/Library/LaunchAgents/dev.baton.daemon.plist
# - Linux: ~/.config/systemd/user/baton.service
# - Windows: Startup folder shortcut invoking scripts/start-daemon.ps1
npm run autostart

# Remove autostart entry:
npm run autostart -- --uninstall
```

---

## 6. Multi-Principal Guest Access

Create `~/.baton/principals.json` to grant a collaborator access to one workspace directory. Use an absolute path on the host.

```json
{
  "guests": [
    {
      "id": "teammate",
      "name": "Alice",
      "root": "/path/to/shared-project",
      "allowSend": true
    }
  ]
}
```

Restart Baton to load the configuration. Then mint a pairing code for the guest.

```bash
baton pair --for teammate
```

Guests see sessions whose working directories resolve inside their configured `root`. Directory browsing and uploads use the same boundary. Guests can read current permission settings and see their own connected devices. Only the owner can change permission settings or read host quota telemetry.

Omit `root` to use `workspacesRoot/<id>`. Omit `allowSend` to inherit the host's setting, or use `false` for a read-only guest. When reassigning the same ID to a new person with the same name and directory, set or increase `credentialVersion` and restart before pairing the new person. [Guest configuration reference](cli.md#batonprincipalsjson)
