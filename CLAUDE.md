# CLAUDE.md

Developer & contributor guide for **Baton** — a local-first remote monitor & controller daemon for Claude Code, OpenAI Codex, and Gemini Antigravity.

## Commands

```bash
npm start            # Start the daemon (default 127.0.0.1:3002)
npm run pair         # Mint a 12-character one-time pairing code (valid 10 min)
npm test             # Run Node built-in server test suite (tests run with --import ./test/setup.js)
npm run check        # Run syntax + full server tests
npm run web:build    # Build desktop/mobile web UI (web/ -> web/dist/)
npm run build:web    # Build Expo PWA/web bundle (app/ -> app/dist/)
```

> **Note for contributors**: For private local deployment details, live machine notes, or local tunnel hostnames, create a gitignored `CLAUDE.local.md` (already listed in `.gitignore`). Never commit real hostnames, tokens, transcripts, or machine-specific paths.

## Architecture & Module Map

- `src/` — Zero-dependency Node 24 daemon (`node:http`, `node:sqlite`, SSE)
  - `src/cli.js` — Startup orchestration, reconciliation, config/token setup, HTTP listener
  - `src/http/` — Auth (cookie/Bearer HMAC + rate limiting), static serving, SSE, handlers
  - `src/agent/` — Subprocess runners (`claude -p`, `codex exec`, `codex app-server`, `agy` / Antigravity bridge), preflight credential checks, slash/skill command discovery
  - `src/{claude,codex,antigravity,repo,titles,models,usage,audit,scope,principals,wire}.js` — Bounded transcript parsers, title resolution, workspace isolation, redaction/wire formatting
- `web/` — React 19 + TypeScript + Vite 8 desktop Web UI (built into `web/dist/`)
- `app/` — Expo / React Native mobile app & PWA (iOS, Android, PWA via `expo-router` & `zustand`)
- `sidecars/baton-bridge/` — Antigravity companion plugin bridge
- `docs/` — Architecture, CLI, HTTP/SSE wire reference, installation, and protocol specifications (`docs/ops/agent-protocol.md` §0–§23; **do not renumber `§0`–`§23`** because code comments and tests cross-reference these section numbers directly)

## v1 Core Constraints (Preserve Unless Deliberately Extended)

1. **No giant transcript loads into RAM**: Parse transcripts with bounded head/tail byte windows (`64 KB`–`256 KB`) or streaming fixed-buffer scanners; never `readFileSync().split('\n')` whole histories.
2. **File path / key is identity**: Never invent synthetic session mapping databases; keep identity grounded in agent transcript files/stores.
3. **Use the host's installed CLIs**: Spawn `claude`, `codex`, `agy` via explicit `argv` allowlists (`src/agent/args.js`), piping prompts over UTF-8 `stdin`. Never invoke shells (`shell: false`).
4. **Actionable errors**: All HTTP error responses return `{ error: { code, message, fix } }` with clear remediation steps.
5. **Host filesystem hygiene**: Keep tests strictly in temporary directories (`os.tmpdir()`). Note `test/setup.js` sets an isolated `HOME` / `USERPROFILE` / `LOCALAPPDATA` so test runs never touch real user session directories under `~/.claude`, `~/.codex`, or `~/.gemini`.

## Three Historical Pitfalls to Watch For

1. **Nested agent credential stripping**: When testing Baton or running `claude -p` inside a parent agent shell, `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` may be scrubbed by the host shell. Launch the daemon from a clean user session or inspect OAuth credentials in `~/.claude/.credentials.json` (or macOS Keychain).
2. **Stale processes vs code on disk**: A long-running `baton` daemon holds its module graph in memory. Code edits require restarting the daemon to take effect on live ports; conversely, avoid disrupting a user's live daemon during development unless explicitly asked—test against an isolated ephemeral port (`port: 0`).
3. **Never write test probes into real session directories**: Pass `--no-session-persistence` (`claude -p`) or `--ephemeral` (`codex exec`) during non-resume CLI checks, or point tests at temp dirs via `test/setup.js`.
