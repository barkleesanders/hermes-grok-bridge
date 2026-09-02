# PROVE — hermes-grok-bridge 0.1.0

Proved on Grok Bot shared Linux box at **2026-09-02 16:49 PDT**.

## Summary

| Check | Result |
|-------|--------|
| `plugin.json` vs Agent Plugins schema | **PASS** |
| `mcp.json` vs Agent Plugins schema | **PASS** |
| `node --check server/index.mjs` | **PASS** |
| MCP `initialize` | **PASS** (serverInfo hermes-grok-bridge/0.1.0) |
| MCP `tools/list` | **PASS** (8 tools) |
| MCP `tools/call normalize_hermes_event` | **PASS** (kind=on_session_end, id=delivery_id) |
| MCP `post_grok_wake` live | **SKIP** (`GROK_WAKE_URL` unset — do not invent) |
| Local install real copy | **PASS** |
| `loadUserLocalPlugins` | **SKIP** (`@anysphere/cursor-plugins` not installed) |
| Live Hermes CLI | **SKIP** (`hermes` not on PATH) |
| Live wake with credentials | **SKIP** (no URL/token in env) |

## Paths

| Role | Absolute path |
|------|----------------|
| Workspace scaffold | `/workspace/hermes-grok-bridge` |
| Local plugin install | `/home/box/.cursor/plugins/local/hermes-grok-bridge` |
| Schemas used | `/tmp/agent-plugins-schemas/plugin.schema.json`, `mcp.schema.json` |
| Smoke driver | `/workspace/hermes-grok-bridge/scripts/mcp-smoke.mjs` |

Install notes: `rm -rf` then `cp -a` (real directory, distinct inode from workspace; not a symlink).

## Tool names (MCP)

1. `normalize_hermes_event`
2. `post_grok_wake`
3. `ingest_hermes_event`
4. `post_hermes_inbound`
5. `hermes_webhook_list`
6. `hermes_webhook_subscribe`
7. `hermes_webhook_remove`
8. `hermes_webhook_test`

## Smoke normalize sample (redacted)

Input `hook_event_name: on_session_end` → output HermesEvent with `kind: on_session_end`, `id`/`deliveryId` from `delivery_id`.

## What this Grok Bot environment cannot prove

- Cursor **Customize UI** plugin load / enable
- **Org policy** / marketplace publish gates
- **Live Hermes CLI** on this box (`hermes` absent)
- **Live Grok wake** without credentials (`GROK_WAKE_URL` / token unset by design)
- Mini-local LaunchAgent / Tailscale inbound reachability from this box
- `loadUserLocalPlugins` without `@anysphere/cursor-plugins`

## Hold

Do **not** publish. Additive only; secrets via env placeholders; never print tokens.
