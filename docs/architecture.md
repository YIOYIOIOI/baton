# Architecture Overview

Baton is designed around one invariant: **the developer's workstation owns the canonical state**. Baton acts as a lightweight, zero-dependency HTTP/SSE bridge between local AI agent transcripts/processes and authenticated desktop or mobile browsers.

---

## System Topology

```text
+-----------------------------------+        +-----------------------------------+
|  Desktop Web UI (React + Vite)    |        |  Mobile & PWA UI (Expo Router)    |
|  web/ -> web/dist/                |        |  app/ -> app/dist/                |
+-----------------+-----------------+        +-----------------+-----------------+
                  |                                            |
                  +------- HTTPS Tunnel / Tailscale / LAN -----+
                                        |
                                        v
+--------------------------------------------------------------------------------+
|  Baton Daemon (Node >= 24 stdlib: node:http, node:crypto, node:sqlite)         |
|                                                                                |
|  Auth & Isolation          Runtime Engine               Agent Adapters         |
|  - 256-bit host secret     - Bounded JSONL windows      - Claude Code CLI      |
|  - HMAC device cookies     - Live SSE (Last-Event-ID)   - Codex App-Server RPC |
|  - Realpath scope guard    - Per-session turn queue     - Antigravity 3-way    |
|  - Revocation cutoff       - Process-tree reaper        - AskUserQuestion MCP  |
+-------------------+---------------------------+--------------------------------+
                    |                           |
                    v                           v
      ~/.baton/ (Local State)        ~/.claude, ~/.codex, ~/.gemini
```

---

## Core Design Principles

### 1. Local Transcript Continuity (No Sync Database)
Instead of copying conversations into a separate database, `src/repo.js`, `src/claude.js`, `src/codex.js`, and `src/antigravity.js` read the native agent stores directly:
- **Claude Code**: Desktop registry files + JSONL transcripts under `~/.claude/`.
- **OpenAI Codex**: `~/.codex/session_index.jsonl`, rollout JSONL files, and SQLite metadata (`node:sqlite`).
- **Gemini Antigravity**: `conversation_summaries.db` and step artifacts discovered from Antigravity's local directory.

Because identity maps directly to canonical files on disk, turns started in your local IDE/terminal immediately show up on mobile, and remote turns remain resumable back at your desk.

### 2. Zero-Dependency Daemon (`src/`)
Root `package.json` intentionally declares **zero runtime `dependencies`**. Everything in the server daemon relies strictly on Node.js `>= 24`:
- `node:http` / `node:https` for serving APIs, SSE streams, and SSRF-hardened Web Push
- `node:crypto` for 256-bit host secrets and timing-safe HMAC credential validation
- `node:sqlite` for reading local SQLite state without native C++ addons
- `node:child_process` for explicit `argv`-allowlisted process execution with cross-platform tree termination (`taskkill /t` on Windows, negative-PID process group termination on POSIX with non-positive PID guards)

### 3. Memory-Bounded Streaming & Truncation
Real coding agent transcripts frequently exceed 100 MB with base64 logs or large diffs:
- `src/jsonl.js` & `src/sessioninfo.js` inspect metadata via bounded head/tail reads (`64 KB`–`256 KB`) and chunked 4 MiB byte-offset scanning—never calling `readFileSync().split('\n')` on unbounded logs.
- `src/follow.js` caps per-tick chunks (`8 MiB`), skips oversized single lines cleanly (`32 MiB`), and closes slow SSE sockets cleanly under write backpressure.
- `src/wire.js` truncates long `tool.input` / `tool.output` payloads over the wire while attaching byte anchors so `GET /api/sessions/:key/events/:id/full` can stream exact slices on demand.

### 4. Dual-Surface Client Split (`web/` vs `app/`)
Static serving (`src/http/static.js`) inspects the `User-Agent` per request via `pickWebRoot({ mobile })`:
- Desktop browsers receive `web/dist/` (React 19 + TypeScript + Vite 8 desktop workstation layout with persistent session sidebar, inspector pane, and `Ctrl+K` command palette).
- Mobile browsers and PWAs receive `app/dist/` (Expo Router thumb-zone UI tuned for compact viewports and native touch targets).
- If only one bundle is built, both device classes serve that bundle gracefully.

### 5. Security & Multi-Principal Boundaries
- **Host-Scoped Credentials**: Pairings generate unique `deviceId` tokens via CSPRNG pairing codes (`12` chars, unambiguous 32-char alphabet, IP + global rate limits). Browsers receive `HttpOnly` cookies (dynamic `Secure` flag via `isSecureRequest`); native callers request Bearer tokens explicitly.
- **Canonical Path Containment**: `src/scope.js`, `src/sessionfs.js`, and `src/upload.js` resolve canonical paths and check symlinks lexically before opening files or creating `.baton-uploads/.gitignore`, preventing directory traversal and dangling symlink escapes.
- **Immutable `--read-only` Mode**: Disables message execution, session creation, directory creation, uploads, and queued turn drains across all callers.
