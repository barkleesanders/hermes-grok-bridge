# hermes-grok-bridge

Smallest working Agent Plugin that wraps the Hermes ↔ Grok Bot wake bridge as **MCP + one skill**.

Additive to host LaunchAgent / queue glue. Secrets via env placeholders only — never commit or print them. Proven locally (see PROVE.md). Configure secrets via env only.

## Install (local)

```bash
rm -rf ~/.cursor/plugins/local/hermes-grok-bridge
cp -a /path/to/hermes-grok-bridge ~/.cursor/plugins/local/hermes-grok-bridge
```

Set env for the MCP server (Cursor mcp / shell profile). Then reload local plugins if your host supports `loadUserLocalPlugins`.

## MCP tools

| Tool | Purpose |
|------|---------|
| `normalize_hermes_event` | Raw outbound JSON (+ headers) → HermesEvent |
| `post_grok_wake` | POST contentful body (or `reason` as text/plain) to `GROK_WAKE_URL`. Empty `{}` is skipped. |
| `ingest_hermes_event` | Normalize + wake if kind allowed, else skipped |
| `post_hermes_inbound` | POST to Hermes webhook base |
| `hermes_webhook_list` | `hermes webhook list` |
| `hermes_webhook_subscribe` | `hermes webhook subscribe` |
| `hermes_webhook_remove` | `hermes webhook remove` |
| `hermes_webhook_test` | `hermes webhook test` |

## Domain types

- **HermesEvent** `{ id, kind, sessionId?, profile?, toolName?, deliveryId?, timestamp?, cwd?, extra?, raw }`
- **GrokWake** `{ targetAgentId?, reason?, hermesEventId?, body }` — `body` must have keys or `reason` must be set; empty `{}` is skipped, never posted.
- **Subscription** `{ name, platform?, events?, deliver?, script?, secretEnv?, deliverOnly? }`
- **BridgeDelivery** `{ status: sent\|failed\|skipped, httpStatus?, error?, at, mode? }`

## Phase 1 vs Phase 2

- **Phase 1 (implemented):** outbound kinds from hooks — default `on_session_end`, `on_session_finalize` (override with `HERMES_OUTBOUND_EVENTS`). Inbound Hermes webhook CLI + POST helper.
- **Phase 2 (adapters only — not implemented):** do **not** invent `message` | `agent_event` | `cron_alert` as Phase 1 outbound kinds. Document future adapters separately.

## Environment variables

No top-level `variables` in `plugin.json` (Agent Plugins schema is closed). Configure via process env:

| Variable | Maps from / notes |
|----------|-------------------|
| `GROK_WAKE_URL` | Often `GROK_TELEGRAM_WEBHOOK_URL` |
| `GROK_WAKE_TOKEN` | Often `GROK_TELEGRAM_WEBHOOK_KEY` |
| `GROK_DEFAULT_AGENT_ID` | Example shape `329a3d61-3369-42d5-926a-46347dc0e232` — **not** hard-coded in server |
| `HERMES_WEBHOOK_BASE` | Public/Tailscale base; box cannot hit Mini localhost |
| `HERMES_WEBHOOK_NAME` | Default inbound webhook name |
| `HERMES_WEBHOOK_SECRET` | Optional; never log |
| `HERMES_CLI` | Default `hermes` |
| `HERMES_OUTBOUND_EVENTS` | Default `on_session_end,on_session_finalize` |
| `HERMES_OUTBOUND_COS_RATE` | Seconds between wakes; default `5` |

Wake auth: primary `Authorization: Bearer` + `X-Automation-Key`; on HTTP 401 retry with `X-Webhook-Key` only. Timeout 8s. Fail-open (return `BridgeDelivery` failed, do not crash).

## Additive vs Mini-local

- This plugin does **not** disable Hermes jobs or replace Mini LaunchAgents.
- Reference listener: `scripts/reference-outbound-bridge.mjs` — host-local hosting stays on Mini.
- Inbound from Grok Linux box requires Tailscale or public URL, not `localhost`.

## Prove

See `PROVE.md`. Local MCP smoke and Mini live wake/CLI smoke completed 2026-09-02.

## License

MIT
