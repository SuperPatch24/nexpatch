# App Control agent 2.1 (not live yet)

These files were uploaded to the top of the repository but never connected to the backend, so the live site still uses
the original App Control collector (`api/src/lib/collector.js`, runs every 15 minutes with the organization's key).

What 2.1 adds (see `APP-CONTROL-AGENT.md`): a boot-time scheduled task that sends events within seconds, per-device
enrollment with a short-lived key, a per-device token stored with DPAPI, heartbeats, rate limits and per-device revoke.

To make it live, the backend still needs:
- `POST /api/appcontrol/enroll` and token-based `POST /api/appcontrol/ingest` (the script calls `<base>enroll` and `<base>ingest`),
  using `agentauth.js` for keys, hashing and rate limits;
- device list / revoke / restore endpoints and the "Devices running the agent" screen in App Control > Activity;
- the installer download in App Control > Activity that embeds the enrollment key;
- tests, then a pilot on a few devices before replacing the 1.x collector.

Nothing in this folder is deployed: Cloudflare publishes only `public/` and the backend deploys only `api/`.
