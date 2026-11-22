# HTTP & SSE Wire API Reference

The authoritative route table lives in [`src/http/routes.js`](../src/http/routes.js) and [`src/http/server.js`](../src/http/server.js). Every response includes `X-Baton: 1` (allowing clients to distinguish genuine Baton errors from captive portals or tunnel 502s) and security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`).

---

## Authentication

- **Web clients** exchange `{ "code": "..." }` at `POST /api/pair` for an `HttpOnly`, `SameSite=Lax` cookie. HTTPS requests also get `Secure`. The response includes the public `deviceId` assigned to that cookie. Before displaying the new identity, fetch `GET /api/health` using the browser cookie and check that the two device IDs match.
- **Native and API clients** can send `{ "code": "...", "want": "bearer" }` to the same endpoint. The response includes `ok`, `deviceId`, and `bearer`. Send the credential in `Authorization: Bearer <token>`.
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
| `GET /api/health` | Authenticated | Version, `allowSend`, `permissionModes`, caller `principal` (`id`, `isOwner`), and the current credential's `deviceId` (`null` for shared or master credentials) |
| `GET /api/devices` | Authenticated | List active paired devices visible to caller |
| `POST /api/devices/revoke` | Authenticated | Revoke a paired device immediately (`self: boolean`) |
| `POST /api/pair/qr` | Owner-only | Mint single-use code + inline SVG QR + pairing URL |
| `POST /api/pair/new` | Owner-only | Mint single-use code for `owner` or a guest principal ID |

### Sessions, Streaming & Turns

| Method & Path | Auth | Description |
|---|---|---|
| `GET /api/sessions` | Scoped | Grouped session chains (`cwd` filtered to `principal.roots`) |
| `POST /api/sessions` | Scoped (`allowSend`) | Create and start a new session (`agent`, `cwd`, `message`, optional `model`, `effort`) |
| `GET /api/session-creations/:turnId` | Original principal, identity generation and workspace | Check a desktop creation receipt. Returns `unconfirmed`, `identified` with the session key, or `failed` with the error. |
| `GET /api/sessions/:key/events` | Scoped | Fetch bounded paginated events (`?before=`, `?limit=`) |
| `GET /api/sessions/:key/events/:id/full` | Scoped | Fetch untruncated tool input/output slice (`?offset=&from=&to=`, `id` URL-encoded with `%23`) |
| `GET /api/sessions/:key/state` | Scoped | Live turn status, queue, pending `AskUserQuestion` card, model & effort |
| `GET /api/sessions/:key/stream` | Scoped | Server-Sent Events stream (`Last-Event-ID` or `?from=`, heartbeat comments) |
| `GET /api/sessions/:key/info` | Scoped | Session metadata, plan/goal, git/file edits (`?file=` for diff details) |
| `GET /api/sessions/:key/export` | Scoped | Download session transcript as formatted Markdown (`.md`) |
| `POST /api/sessions/:key/send` | Scoped (`allowSend`) | Run turn or enqueue (`when`: `auto` / `now` / `interrupt`, optional `fork`) |
| `POST /api/sessions/:key/stop` | Scoped (`allowSend`) | Request cancellation by `turnId`. A local runner returns HTTP 202 with `stopping: true` until it exits. A desktop bridge returns HTTP 200 with `stopped: false` and directs the caller to the desktop. |
| `POST /api/sessions/:key/queue/cancel` | Scoped (`allowSend`) | Cancel a queued prompt by `id` |
| `POST /api/sessions/:key/queue/promote` | Scoped (`allowSend`) | Promote an existing queued prompt by `id`, preserving its sender, contents, and fork setting. |
| `POST /api/sessions/:key/answer` | Scoped (`allowSend`) | Answer a pending `AskUserQuestion` prompt (`askId`, `picked`, `free`) |
| `POST /api/sessions/:key/goal` | Scoped (`allowSend`) | Set (`{ objective }`) or clear (`{ clear: true }`) active goal |

Clients can follow `turn_control` and `turn_end` on the session stream. A running turn with `canStop: false` requires desktop control. Ordinary queued messages wait for the current turn to finish.

If Antigravity Desktop has not published a unique session for a new request, HTTP 202 can return `status: "unconfirmed"`, `turnId`, `statusUrl`, and null `key` and `sessionId`. Poll the returned URL with GET. Baton records the request before dispatch and continues observing across restarts. The original POST may already have taken effect.

A recovered desktop turn can also report `status: "unconfirmed"` when two turns overlapped and their outputs cannot be assigned after a restart. The ordinary queue stays paused. Check the result in Antigravity Desktop, then explicitly promote the next queued message or send a new message with `when: "now"`.

The events response includes `endOffset`, the byte position just after the last complete JSONL record in that snapshot. Open the stream with `?from=<endOffset>` to receive later records, including a record completed between the two requests. Resume from the last SSE event ID after a disconnect. If the stream reports a `gap`, fetch history using `nextBefore` until it overlaps the events already displayed, merge by event ID, and resume from the new snapshot.

After a daemon restart, Baton checks a recorded worker's OS process ID and creation time before keeping its session occupied. Recovered process IDs are used only for observation. When the OS cannot verify a creation time, or an older turn has only a PID, Baton keeps the session occupied while that PID or its recorded POSIX process group still exists.

#### Retrying a send

Clients can include `requestId` in `POST /api/sessions/:key/send`. Generate one ID per user action and reuse it when retrying after a lost response. Accepted IDs contain 1–128 ASCII letters, digits, periods, underscores, colons or hyphens. The ID belongs to the authenticated principal, its current identity generation and the session. Another principal or session can independently use the same ID. Within that scope, changing the message, `fork` or `when` returns HTTP 409 `request_id_conflict`.

A retry returns HTTP 202 with the original `turnId` for an immediate send, or the original `queueId` for a queued send. `replayed: true` identifies a repeated acknowledgement. A queued message keeps that acknowledgement when it begins running, finishes or is withdrawn. Check session state for its current status.

Baton keeps a durable receipt for at least 24 hours after acceptance, including across daemon restarts. Pending queue entries and retained turns also remember their original request. Once the guarantee expires and the original entry has been removed, reusing the ID can start a new send. Each data directory holds up to 10,000 unexpired receipts. At capacity, new identified sends return HTTP 429 `request_history_full` and can be retried later with the same ID.

If the receipt index is temporarily unwritable, Baton preserves already accepted sends in their durable queue or turn records. A new send can return HTTP 503 while the index is recovering. Retry with the original request ID.

If the receipt index fails after the send has been recorded, its queue entry or turn preserves the acknowledgement. New identified sends can return HTTP 503 `receipt_store_unavailable` until the index recovers. Retry those requests with the same ID.

`queue/promote` returns HTTP 202 with the original `queueId`. `queued: true` means the item is waiting for the current runner to exit. `queued: false` includes the `turnId` that started. If the runner is monitor-only, the server returns HTTP 409 `stop_unavailable` and leaves the queue in order. A competing stop can return `stop_pending`. An item already withdrawn returns HTTP 404 `unknown_queue_item`.

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
| `POST /api/push/subscribe` / `unsubscribe` | Paired device | Manage this device's Web Push endpoint. Each identity can register 32 subscriptions. At capacity a new endpoint gets HTTP 429. Revoking a device removes its subscriptions. |
| `GET /api/push/latest` | Scoped | Return the latest finished turn visible to the authenticated identity. The key, title and status are null when the session is no longer visible. |
