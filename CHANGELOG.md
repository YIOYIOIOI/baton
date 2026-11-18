# Changelog

All notable changes to Baton are documented in this file.

## [0.2.0] - 2026-11-18

### Added
- **Modern CLI (`baton`)**: Unified entrypoint supporting `baton start [--port N] [--host ADDR] [--tunnel] [--read-only]`, `baton pair [--for ID] [--port N] [--host ADDR]`, `baton doctor [--json]`, and `baton tunnel [--port N]`.
- **Full Gemini Antigravity Parity**: Hybrid 3-channel execution (`baton-bridge` sidecar + `agy acp --stdio` + `stream-json`), ACP authoritative model & 5-tier effort catalog (`low`–`max`), `auto` permission mode, and live owner-only `/usage` quota telemetry.
- **Connected Devices & Instant Revocation**: Track paired devices (`GET /api/devices`), revoke individual devices (`POST /api/devices/revoke`), and close active SSE streams immediately on revocation.
- **In-App Owner QR Pairing**: Paired owners can generate single-use 12-char pairing codes and SVG QR codes directly from Settings (`POST /api/pair/qr`) in both Desktop Web and Mobile UIs.
- **Markdown Session Export**: Export full conversations with tool calls and timestamps (`GET /api/sessions/:key/export`) from Web (`InfoPanel`, `ConvHead`, `Palette`) and Mobile (`SessionMenu`).
- **Bilingual UI (`en` + `zh-CN`)**: Full `Auto / EN / 中文` interface switching across Web and Mobile without altering raw agent transcripts, paths, or code.
- **Cloudflare Quick Tunnel & Tailscale Hardening**: Adaptive `Secure` cookie detection (`isSecureRequest`), Tailscale CGNAT (`100.64.0.0/10`) address discovery, and cross-platform autostart template installer (`scripts/install-autostart.mjs`).
- **Open-Source Release Tooling**: Added `MIT` `LICENSE`, [`docs/third-party-notices.md`](docs/third-party-notices.md), bilingual documentation (`README.md`, [`docs/README.zh-CN.md`](docs/README.zh-CN.md), [`docs/installation.md`](docs/installation.md), [`docs/privacy.md`](docs/privacy.md), [`.github/SECURITY.md`](.github/SECURITY.md), [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)), automated sanitization check (`npm run oss:check`), and cross-platform CI/release workflows.

### Security & Reliability
- Enforced `--read-only` ceiling across server endpoints and queued turn draining.
- Added SSRF protections (DNS pre-validation, private/CGNAT/loopback blocking, redirect blocking) to Web Push delivery.
- Bounded stream buffers, upload sizes (`413`), turn queue limits (`429`), chunked 4 MiB transcript scanning, fail-safe revocation storage, and WCAG AA contrast updates (`#855200` warning text).

## [0.1.0] - 2026-11-12

### Baseline
- Initial private self-hosted Baton server, Vite Desktop Web UI, Expo Mobile/PWA UI, and Gemini Antigravity sidecar bridge.
