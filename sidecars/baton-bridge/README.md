# Baton Bridge Plugin for Gemini Antigravity

Companion sidecar plugin managed by Baton and synchronized into `~/.gemini/config/plugins/baton-bridge/`:

- Binds strictly to an ephemeral `127.0.0.1` loopback port with Bearer authentication against `~/.baton/token`.
- Routes turns through the host-injected `agentapi` (`ANTIGRAVITY_AGENTAPI_EXE`) without touching internal lockfiles or unexposed host sockets.
- Automatically activates on the next Antigravity desktop restart after deployment without editing `config.json`.
