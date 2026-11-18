# HTTP & SSE Wire API Reference

The authoritative route table lives in [`src/http/routes.js`](../src/http/routes.js) and [`src/http/server.js`](../src/http/server.js). Every response includes `X-Baton: 1` (allowing clients to distinguish genuine Baton errors from captive portals or tunnel 502s) and security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`).

---

## Authentication

- **Web Clients**: `POST /api/pair` `{ "code": "..." }` issues an `HttpOnly`, `SameSite=Lax` cookie (`Secure` applied dynamically when `isSecureRequest(req)` is true).
- **Native / API Clients**: `POST /api/pair` `{ "code": "...", "want": "bearer" }` returns `{ "ok": true, "bearer": "..." }` for `Authorization: Bearer <token>`.
- **Local Trusted Access**: Bearer token matching `~/.baton/token` authenticates as `owner`.
- **Unpair**: `POST /api/unpair` clears the browser cookie without revoking unrelated devices.
- **Revocation**: `POST /api/devices/revoke` `{ "deviceId": "..." }` invalidates that credential immediately and terminates any active SSE streams bound to it.

---

## Error Envelope

All `4xx` / `5xx` JSON errors share one structured schema with actionable remediation:

```json
{
  "error": {
    "code": "send_disabled",
    "message": "Daemon is running in read-only mode.",
    "fix": "Restart Baton without --read-only or enable allowSend in config.json."
  }
}
```

---

## Endpoints

### System, Pairing & Devices

| Method & Path | Auth | Description |
|---|---|---|
| `POST /api/pair` | Public (rate-limited) | Exchange 12-char CSPRNG code for cookie or Bearer credential |
| `POST /api/unpair` | Cookie/Public | Expire browser session cookie |
| `GET /api/health` | Authenticated | Version, `allowSend`, `permissionModes`, caller `principal` (`id`, `isOwner`) |
| `GET /api/devices` | Authenticated | List active paired devices visible to caller |
| `POST /api/devices/revoke` | Authenticated | Revoke a paired device immediately (`self: boolean`) |
| `POST /api/pair/qr` | Owner-only | Mint single-use code + inline SVG QR + pairing URL |
| `POST /api/pair/new` | Owner-only | Mint single-use code for `owner` or a guest principal ID |

### Sessions, Streaming & Turns

| Method & Path | Auth | Description |
|---|---|---|
| `GET /api/sessions` | Scoped | Grouped session chains (`cwd` filtered to `principal.roots`) |
| `POST /api/sessions` | Scoped (`allowSend`) | Create and start a new session (`agent`, `cwd`, `message`, optional `model`, `effort`) |
| `GET /api/sessions/:key/events` | Scoped | Fetch bounded paginated events (`?before=`, `?limit=`) |
| `GET /api/sessions/:key/events/:id/full` | Scoped | Fetch untruncated tool input/output slice (`?offset=&from=&to=`, `id` URL-encoded with `%23`) |
| `GET /api/sessions/:key/state` | Scoped | Live turn status, queue, pending `AskUserQuestion` card, model & effort |
| `GET /api/sessions/:key/stream` | Scoped | Server-Sent Events stream (`Last-Event-ID` or `?from=`, heartbeat comments) |
| `GET /api/sessions/:key/info` | Scoped | Session metadata, plan/goal, git/file edits (`?file=` for diff details) |
| `GET /api/sessions/:key/export` | Scoped | Download session transcript as formatted Markdown (`.md`) |
| `POST /api/sessions/:key/send` | Scoped (`allowSend`) | Run turn or enqueue (`when`: `auto` / `now` / `interrupt`, optional `fork`) |
| `POST /api/sessions/:key/stop` | Scoped (`allowSend`) | Terminate active process tree / ACP turn and mark stopped |
| `POST /api/sessions/:key/queue/cancel` | Scoped (`allowSend`) | Cancel a queued prompt by `id` |
| `POST /api/sessions/:key/answer` | Scoped (`allowSend`) | Answer a pending `AskUserQuestion` prompt (`askId`, `picked`, `free`) |
| `POST /api/sessions/:key/goal` | Scoped (`allowSend`) | Set (`{ objective }`) or clear (`{ clear: true }`) active goal |

### Models, Commands, Files & Push

| Method & Path | Auth | Description |
|---|---|---|
| `GET /api/models` | Authenticated | Discovered models, context windows, and effort presets across Claude, Codex, and Antigravity |
| `GET /api/usage` | Owner-only | Quota / usage telemetry (`?refresh=1` bypasses cache) |
| `GET /api/permission` | Owner-only | Read per-agent permission mode settings |
| `POST /api/permission` | Owner-only | Update per-agent permission mode (`agent`, `mode`) |
| `POST /api/sessions/:key/model` | Scoped (`allowSend`) | Pin session model (`{ model }`) |
| `POST /api/sessions/:key/effort` | Scoped (`allowSend`) | Pin session reasoning effort (`{ effort }`) |
| `GET /api/sessions/:key/commands` | Scoped | List slash commands and skills (`?probe=1` refreshes cache) |
| `GET /api/dirs` / `POST /api/dirs` | Scoped | Browse directories or create directory (`allowSend` required for `POST`) |
| `GET /api/sessions/:key/files` | Scoped | List workspace files under session `cwd` |
| `GET /api/sessions/:key/file` | Scoped | Download file inside session `cwd` (`?path=...`) |
| `POST /api/sessions/:key/upload` | Scoped (`allowSend`) | Upload raw attachment bytes to `<cwd>/.baton-uploads` (`?name=...`) |
| `POST /api/uploads` | Scoped (`allowSend`) | Pre-session attachment upload scoped to `?cwd=...&name=...` |
| `GET /api/sessions/:key/upload` | Scoped | Read uploaded attachment preview (`?name=...`) |
| `GET /api/push/key` | Authenticated | Retrieve host VAPID public key |
| `POST /api/push/subscribe` / `unsubscribe` | Authenticated | Register or remove browser Web Push subscription |
| `GET /api/push/latest` | Authenticated | Fetch summary of latest finished turn for notification rendering |
