# Baton Bridge Plugin for Gemini Antigravity

Baton installs this companion plugin in `~/.gemini/config/plugins/baton-bridge/`. It uses the desktop host’s `agentapi` to send messages and create conversations.

Bridge protocol v2 listens on an ephemeral `127.0.0.1` port. Each process generates a new instance ID and a 256-bit secret and writes them to its private `~/.baton/antigravity-bridges/<pid>.json` registration. Baton sends a random challenge to `/health` and verifies the signed reply against that registration. Each subsequent `POST` and its receipt carry an HMAC-SHA256 signature tied to a fresh request nonce. The sidecar checks the request timestamp and accepts each signed request once.

Baton updates the plugin files when its server starts. Restart Antigravity Desktop once after installing or upgrading the plugin to load v2. While an earlier sidecar is still running, Baton can use an installed `agy` CLI.

On POSIX the data directory must belong to the desktop user and its path must be protected from replacement by other users. The sidecar tightens its own older registration directory to mode `0700` on startup and writes single-link regular registration files with mode `0600`. On Windows the trust boundary is the NTFS ACL protecting `BATON_DIR` and its parent path. Keep write access to that directory and read access to registration secrets limited to the desktop user and trusted administrators. The bridge rejects registration-directory junctions and linked registration files.

A signed error receipt includes `delivery`. The value `not_dispatched` means the sidecar rejected the request or could not start `agentapi`. Once `agentapi` has started, a failure carries `unknown`. Baton reports a definite rejection immediately and keeps observing a possibly delivered message until the desktop provides evidence for that turn.
