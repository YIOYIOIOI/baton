# Privacy Notice

Baton is a **100% local-first, self-hosted** application:

1. **Zero Telemetry or Analytics**: Baton includes no analytics SDKs, crash-reporting beacons, license checks, or phone-home requests.
2. **Local Storage Only**: All runtime state (`~/.baton/token`, `config.json`, `principals.json`, `devices.json`, `revoked.json`, `push.json`, and audit logs) resides solely on the workstation running the Baton daemon.
3. **Direct Agent Invocation**: Prompts and transcripts flow strictly between your host machine, your paired devices, and whichever AI coding agent CLI (`claude`, `codex`, `agy`) and API endpoint you configure locally.
4. **No Automatic External Image Fetches**: In the Web UI (`web/src/Markdown.tsx`), `http(s)` image links generated in agent replies render as opt-in clickable links rather than auto-loaded `<img src>` tags, preventing third-party tracking pixels or unintentional network requests.
5. **Optional Web Push**: If you opt in to browser notifications, the host stores only the browser push endpoint URL and VAPID keys needed to deliver completion alerts directly to your browser's push service.
