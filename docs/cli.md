# CLI & Configuration Reference

When installed globally (`npm install -g ...`) or linked locally (`npm link`), the entrypoint is `baton`. From a source checkout, run `node src/cli.js <command>`.

---

## Subcommands

### `baton [start]`
Starts the Baton HTTP daemon. Running `baton` with no arguments defaults to `start`.

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `3002` | TCP port to listen on (`1`–`65535`) |
| `--host <addr>` | `127.0.0.1` | Bind address (use `127.0.0.1` behind reverse tunnels or a Tailscale IP) |
| `--quick-tunnel`, `--tunnel` | `false` | Launch an ephemeral `cloudflared` Quick Tunnel (`trycloudflare.com`) and print its QR/pairing link |
| `--read-only` | `false` | Enforce global read-only ceiling (blocks turn execution, session creation, directory creation, uploads) |

### `baton pair`
Mints a single-use 12-character pairing code and writes an SVG QR code (`~/.baton/pairing-qr.svg`, mode `0600` on POSIX).

| Flag | Default | Description |
|---|---|---|
| `--for <id>` | `owner` | Principal ID from `~/.baton/principals.json` |
| `--port <n>` | config port | Override daemon port to contact |
| `--host <addr>` | config host | Override daemon host to contact |

### `baton doctor`
Inspects workstation readiness without mutating session data.

| Flag | Default | Description |
|---|---|---|
| `--json` | `false` | Output machine-readable diagnostics (Node version, `node:sqlite`, `claude`/`codex`/`agy`/`cloudflared` binaries, `web/dist` & `app/dist`, LAN/Tailscale IPs) |

### `baton tunnel`
Runs a standalone Cloudflare Quick Tunnel forwarding to the local Baton port.

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `3002` | Target local port |

### Other Utilities & Scripts
- `npm run revoke-legacy`: Invalidates legacy pre-device credentials for a principal.
- `npm run setup`: Installs dependencies across `/`, `web/`, and `app/` and builds both web UI bundles.
- `npm run autostart [--dry-run | --uninstall]`: Installs OS background startup integration.

---

## Configuration Files (`~/.baton/`)

Override runtime location with `BATON_DIR=/path/to/dir` if needed.

### `~/.baton/config.json`

| Key | Default | Description |
|---|---|---|
| `host` | `"127.0.0.1"` | Default daemon bind host |
| `port` | `3002` | Default daemon port |
| `allowSend` | `true` | Global allow-send toggle (`--read-only` overrides to `false`) |
| `publicUrl` | `null` | Base HTTPS URL used in QR pairing links (e.g., `https://baton.example.com`) |
| `devCorsOrigin` | `null` | Exact allowed CORS origin for local client dev (wildcard `*` rejected) |
| `workspacesRoot` | `C:\BatonWorkspaces` / `~/BatonWorkspaces` | Default root proposed for new workspaces |

### `~/.baton/principals.json`
Optional array of guest principals with scoped directory allowlists:

```json
[
  {
    "id": "reviewer",
    "name": "Alice",
    "roots": ["/home/dev/workspace/frontend"],
    "allowSend": false
  }
]
```
- `roots: null` grants full host access (reserved for `owner`).
- `allowSend: false` restricts that collaborator to read-only observation even when global `allowSend` is `true`.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `BATON_DIR` | Override `~/.baton` runtime storage directory |
| `CLAUDE_CONFIG_DIR` | Override default `~/.claude` discovery & credential path |
| `CODEX_HOME` | Override default `~/.codex` discovery path |
| `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` | Used in CI workflows to run actions cleanly on Node 24 |
