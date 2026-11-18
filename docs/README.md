# Baton Documentation

Welcome to the engineering documentation for **Baton**.

## Guides

| Document | Audience & Scope |
|---|---|
| [Installation & Operations](installation.md) | Prebuilt tarball install, building from source (`npm run setup`), Tailscale, Cloudflare Quick/Named Tunnels, OS autostart, and guest isolation |
| [Architecture Overview](architecture.md) | Local-first transcript discovery, zero-dependency Node 24 daemon, bounded JSONL tailing, SSE catch-up, process-tree reaping, and security boundaries |
| [CLI & Configuration](cli.md) | `baton` subcommands (`start`, `pair`, `doctor`, `tunnel`, `revoke-legacy`), flags, `~/.baton/config.json`, and `principals.json` |
| [HTTP & SSE Wire API](api.md) | REST endpoints, cookie/Bearer HMAC authentication, SSE streaming, error envelope, and client contracts |
| [Cloudflare Tunnel Guide](setup/cloudflare-tunnel.md) | Step-by-step zero-open-port remote HTTPS setup with Cloudflare Named Tunnels |
| [Chinese Overview (简体中文)](README.zh-CN.md) | 简体中文项目说明与快速上手 |

## Governance & Policies

| Document | Scope |
|---|---|
| [Security Policy](../.github/SECURITY.md) | Threat model, HMAC device credentials, SSRF protections, and private vulnerability reporting |
| [Privacy Notice](privacy.md) | Local-only storage, zero telemetry, external image policy, and Web Push behavior |
| [Contributing Guide](../.github/CONTRIBUTING.md) | Test isolation rules (`--import ./test/setup.js`), coding invariants, and PR checklist |
| [Support](../.github/SUPPORT.md) | Discussions, `baton doctor --json` diagnostics, and issue reporting |
| [Third-Party Notices](third-party-notices.md) | Attributions and runtime dependency overview |

## Internal Protocol Specs

| Document | Scope |
|---|---|
| [Agent Protocol Internals](ops/agent-protocol.md) | Empirical protocol notes (`§0`–`§23`) for Claude Code, OpenAI Codex, and Gemini Antigravity CLIs |
| [Desktop Registry Schema](ops/registry-schema.md) | Claude Desktop session metadata layout and compatibility notes |
| [Workspace API Contract](ops/workspace-api-contract.md) | Canonical request/response invariants for session and workspace endpoints |
