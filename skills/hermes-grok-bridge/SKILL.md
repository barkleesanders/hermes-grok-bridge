---
name: hermes-grok-bridge
description: >-
  Use when bridging Hermes session lifecycle to Grok Bot wakes (on_session_end /
  on_session_finalize → post_grok_wake), managing Hermes inbound webhooks
  (list/subscribe/remove/test), or posting wakes into Hermes via webhook base URL.
  Prefer MCP tools over ad-hoc curl. Additive only — never disable Hermes jobs.
---

# hermes-grok-bridge

## When to use

- Hermes outbound session hooks (`on_session_end`, `on_session_finalize`) should wake a Grok Bot agent.
- You need to list, subscribe, test, or remove Hermes inbound webhooks via CLI wrappers.
- You need to POST into a Hermes webhook endpoint from an environment that can reach `HERMES_WEBHOOK_BASE`.

## Domain types

- **HermesEvent** — `{ id, kind, sessionId?, profile?, toolName?, deliveryId?, timestamp?, cwd?, extra?, raw }`
  - `kind` from `X-Hermes-Event` / `hook_event_name`
  - Phase 1 outbound kinds (configurable via `HERMES_OUTBOUND_EVENTS`): `on_session_end`, `on_session_finalize` (defaults)
- **GrokWake** — `{ targetAgentId?, reason?, hermesEventId?, body }`. Provide a nonempty JSON object or a nonblank reason. Empty bodies and arrays are skipped. Event ingestion requires a nonempty `wakeBody` object.
- **Subscription** — `{ name, platform?, events?, deliver?, script?, secretEnv?, deliverOnly? }`
- **BridgeDelivery** — `{ status: sent|failed|skipped, httpStatus?, error?, at, mode? }`

## Phase 1 vs Phase 2

| Phase | Scope |
|-------|--------|
| **Phase 1** (this plugin) | Outbound session hooks → Grok wake; inbound Hermes webhook CLI + POST helpers |
| **Phase 2** (adapters only — not implemented) | Future kinds such as `message`, `agent_event`, `cron_alert` — document adapters; do **not** treat them as Phase 1 outbound kinds |

## Env vars (never print values)

| Var | Role |
|-----|------|
| `GROK_WAKE_URL` | Wake endpoint (often mapped from `GROK_TELEGRAM_WEBHOOK_URL`) |
| `GROK_WAKE_TOKEN` | Auth token (often from `GROK_TELEGRAM_WEBHOOK_KEY`) |
| `GROK_DEFAULT_AGENT_ID` | Optional default agent id for logging / targeting metadata |
| `HERMES_WEBHOOK_BASE` | Base URL for inbound POSTs (Tailscale/public — not Mini localhost from this box) |
| `HERMES_WEBHOOK_NAME` | Default webhook name |
| `HERMES_WEBHOOK_SECRET` | Optional secret header |
| `HERMES_CLI` | Hermes binary path (default `hermes`) |
| `HERMES_OUTBOUND_EVENTS` | Comma list; default `on_session_end,on_session_finalize` |
| `HERMES_OUTBOUND_COS_RATE` | Seconds between wakes; default `5` |

## Rules

- **Additive** — never disable or replace existing Hermes LaunchAgent / queue jobs; this plugin wraps and bridges.
- **Never print secrets** — tokens and webhook secrets stay in env; results must not echo them.
- **Localhost inbound limit** — the Grok Linux box cannot reach Mini `localhost`; inbound needs Tailscale or a public URL.
- Prefer `ingest_hermes_event` for outbound path; use `normalize_hermes_event` alone when debugging payloads.
