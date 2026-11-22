# Scripts

Helper scripts for pairing, autostart installation, daemon supervision, and OSS release hygiene.

> On Windows, invoke PowerShell scripts with PowerShell 7 (`pwsh`) rather than legacy Windows PowerShell 5.1.

## Pairing & Credentials

| Script | Purpose | Usage |
|---|---|---|
| `pair.mjs` | Mint a 12-character one-time pairing code & SVG QR | `npm run pair` (`npm run pair -- --for <principal-id>`) |
| `revoke-legacy.mjs` | Revoke pre-device legacy shared credentials | `npm run revoke-legacy` |

## Daemon & Autostart

| Script | Purpose | Usage |
|---|---|---|
| `install-autostart.mjs` | Install/uninstall OS startup service (`launchd` on macOS, `systemd --user` on Linux, Startup script on Windows) | `npm run autostart` (`--dry-run`, `--uninstall`) |
| `start-daemon.ps1` | Windows Startup runner that inherits user-level environment credentials and restarts the daemon on exit | Invoked by the Startup shortcut (`pwsh -NoProfile -File scripts\start-daemon.ps1`) |
| `watchdog.ps1` | Monitor daemon port, `/api/health`, and optional Cloudflare Tunnel process | `pwsh -NoProfile -File scripts\watchdog.ps1 -Check` |

On Windows, Baton checks for the installed Codex desktop CLI before opening the model menu or starting a turn. If the desktop app is absent, it runs `codex` from `PATH`. The Startup runner rereads the current user's and machine's Codex provider variables for each launch; manual launches keep their shell environment. After changing account, API configuration, or desktop version, reopen the model menu. Select **Default** to follow the configured model on future turns. Baton does not install updates, change a pinned model, or replay a failed turn.

On macOS and Linux, the generated service keeps the installation-time `BATON_DIR`. On Windows, an explicit `--port` overrides the configured port. The launcher records the effective endpoint, PID, native process start time, executable and absolute entry script in the data directory. The watchdog checks these fields and holds the matching process handle during recovery.

## Release & OSS Hygiene

| Script | Purpose | Usage |
|---|---|---|
| `verify-oss-clean.mjs` | Scan tracked files (or an orphan release tree) for secrets, tokens, or personal host paths | `npm run oss:check` |
| `publish-oss.mjs` | Build & verify a clean single-commit `oss-release` orphan branch without switching `main` | `npm run oss:prepare` |

Preparation verifies the candidate Git object before updating the release branch and its ownership marker together. It can refresh a branch it previously created while that branch is checked out nowhere. Choose an unused `--branch` name when an earlier tool or a developer created the existing branch.

The tag workflow also scans the files extracted from its verified npm tarball. To check an unpacked release locally, run `node scripts/verify-oss-clean.mjs --release-dir <unpacked-package-directory>`.
