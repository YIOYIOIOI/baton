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
This optional file contains a `guests` array listing the identities that can pair with this host. Each guest has one workspace.

```json
{
  "guests": [
    {
      "id": "reviewer",
      "name": "Alice",
      "root": "/home/dev/workspace/frontend",
      "allowSend": false
    }
  ]
}
```

- `id` is required. Start with a lowercase ASCII letter or digit and use up to 32 lowercase letters, digits, hyphens or underscores. The host reserves `owner`.
- `name` is an optional nonempty string and defaults to the ID. `root` is an absolute path and defaults to `workspacesRoot/<id>`. Give each guest a separate directory.
- `allowSend` accepts a JSON boolean. Omit it to inherit the host's setting. Global read-only mode also applies to every guest. Startup reports invalid fields and skipped grants.
- `credentialVersion` is an optional positive integer. Set it or increase it before assigning the same ID, name and directory to a different person. Restart Baton after editing the file. Changing the name or resolved directory, or removing a guest and restarting before adding them back, also requires pairing again.

At the first upgrade, existing guests keep their paired devices and shared credentials unless an explicit `credentialVersion` requests rotation. Back up `principal-generations.sqlite` and `principal-generations.ready` with the host token, revocation ledger and configuration. If the initialized identity database is unavailable, restore it to resume guest access. The owner can still use the local host token.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `BATON_DIR` | Override `~/.baton` runtime storage directory |
| `AGY_BIN` | Path to the Antigravity CLI. On Windows, use an absolute host path to the installed executable or batch shim outside the session workspace. Baton also checks the standard Antigravity installation directories and absolute host PATH entries. |
| `CLAUDE_CONFIG_DIR` | Override default `~/.claude` discovery & credential path |
| `CODEX_HOME` | Override default `~/.codex` discovery path |
| `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` | Used in CI workflows to run actions cleanly on Node 24 |
