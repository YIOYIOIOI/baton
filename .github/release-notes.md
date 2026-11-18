## Baton v0.2.0 — Initial Public Release

Continue local **Claude Code**, **OpenAI Codex**, and **Gemini Antigravity** sessions from any desktop browser, phone, or PWA — zero cloud relay, zero database, API-relay friendly.

### Quick Install (Prebuilt UIs Included)

Requires **Node.js >= 24.0.0** and at least one local agent CLI (`claude`, `codex`, or `agy`):

```bash
npm install -g https://github.com/YIOYIOIOI/baton/releases/download/v0.2.0/baton-0.2.0.tgz
baton start
```

Or build from source:

```bash
git clone https://github.com/YIOYIOIOI/baton.git
cd baton
npm run setup
npm start
```

---

### Highlights

- **3-Agent Hybrid Support**:
  - **Claude Code**: `stream-json` tailing, `--mcp-config` interactive `AskUserQuestion` bridging, model/effort selection, and owner usage telemetry.
  - **OpenAI Codex**: Persistent `app-server` JSON-RPC + rollout JSONL tailing, queued handoff when Codex desktop holds the write lock, and `/goal` tracking.
  - **Gemini Antigravity**: Hybrid 3-channel dispatch (`baton-bridge` sidecar, `agy acp --stdio`, `stream-json`), ACP model catalog with 5-tier effort (`low`–`max`), and live `/usage` telemetry.
- **Zero Runtime Dependencies Daemon**: Built purely on Node 24 standard library (`node:http`, `node:crypto`, built-in `node:sqlite`) — no external runtime packages or external databases.
- **In-App Governance & Continuity**: Connected Devices list with instant SSE cutoff on revocation, Owner SVG QR pairing right inside Settings, Markdown session exports, and bilingual `en` / `zh-CN` UI.
- **Multi-Principal Realpath Isolation**: Per-principal `roots` scoping, lexical symlink checks, SSRF-hardened Web Push, adaptive `Secure` cookies for Tailscale/LAN, and `--read-only` mode.
- **Cross-Platform Tested**: Continuous verification across **Linux (`ubuntu-latest`)**, **macOS (`macos-latest`)**, and **Windows (`windows-latest`)**.

See [CHANGELOG.md](https://github.com/YIOYIOIOI/baton/blob/main/CHANGELOG.md) and the [Documentation Hub](https://github.com/YIOYIOIOI/baton/tree/main/docs) for details.
