#!/usr/bin/env node
/**
 * Reference HTTP listener sketch for Hermes outbound hooks → Grok wake.
 *
 * Accepts POST /hermes-events, reads X-Hermes-Event / body, normalizes, and
 * posts a wake when kind is allowed.
 *
 * LaunchAgent / queue hosting stays HOST-LOCAL (e.g. Mini). This script is a
 * thin reference — production may call the MCP tools instead of duplicating logic.
 *
 * Usage (host-local):
 *   HERMES_OUTBOUND_EVENTS=on_session_end,on_session_finalize \
 *   GROK_WAKE_URL=... GROK_WAKE_TOKEN=... \
 *   node scripts/reference-outbound-bridge.mjs
 *
 * Do not invent secrets. Fail-open on wake errors.
 */

import http from "node:http";

// Inline minimal normalize + wake (same semantics as server/index.mjs tools).
// Prefer invoking MCP tools from agents; this is for a standalone host listener.

const DEFAULT_OUTBOUND = "on_session_end,on_session_finalize";
let lastWakeAt = 0;

function env(name, fallback = "") {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function allowedKinds() {
  return env("HERMES_OUTBOUND_EVENTS", DEFAULT_OUTBOUND)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function headerGet(headers, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function normalize(raw, headers) {
  const body = raw && typeof raw === "object" ? raw : {};
  const kind =
    headerGet(headers, "x-hermes-event") ||
    body.hook_event_name ||
    body.kind ||
    "unknown";
  const deliveryId =
    headerGet(headers, "x-hermes-delivery") || body.delivery_id;
  return {
    id: String(deliveryId || body.id || crypto.randomUUID()),
    kind: String(kind),
    sessionId: body.session_id,
    profile: body.profile,
    deliveryId: deliveryId ? String(deliveryId) : undefined,
    timestamp: body.timestamp,
    cwd: body.cwd,
    extra: body.extra,
    raw: body,
  };
}

async function postWake(hermesEventId, reason) {
  const url = env("GROK_WAKE_URL");
  const token = env("GROK_WAKE_TOKEN");
  if (!url) return { status: "failed", error: "GROK_WAKE_URL not set", at: new Date().toISOString() };
  const gap = Number(env("HERMES_OUTBOUND_COS_RATE", "5")) * 1000;
  const wait = lastWakeAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "hermes-grok-bridge/0.1.0-ref",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Automation-Key"] = token;
  }
  const wakeBody = reason ? `[hermes-grok-bridge]\n${reason}` : "";
  if (!wakeBody) {
    return { status: "skipped", error: "empty wake refused", at: new Date().toISOString(), hermesEventId, reason };
  }
  headers["Content-Type"] = "text/plain; charset=utf-8";
  try {
    let res = await fetch(url, { method: "POST", headers, body: wakeBody, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 && token) {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Webhook-Key": token,
          "User-Agent": "hermes-grok-bridge/0.1.0-ref",
        },
        body: wakeBody,
        signal: AbortSignal.timeout(8000),
      });
    }
    lastWakeAt = Date.now();
    return {
      status: res.ok ? "sent" : "failed",
      httpStatus: res.status,
      at: new Date().toISOString(),
      hermesEventId,
      reason,
    };
  } catch (e) {
    lastWakeAt = Date.now();
    return { status: "failed", error: String(e?.message || e), at: new Date().toISOString() };
  }
}

const port = Number(env("BRIDGE_PORT", "8787"));
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/hermes-events") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let raw = {};
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    const event = normalize(raw, req.headers);
    let delivery;
    const rawText =
      (typeof event.raw?.text === "string" && event.raw.text.trim()) ||
      (typeof event.raw?.message === "string" && event.raw.message.trim()) ||
      "";
    if (!allowedKinds().includes(event.kind)) {
      delivery = { status: "skipped", at: new Date().toISOString(), error: `kind ${event.kind}` };
    } else if (!rawText) {
      delivery = { status: "skipped", at: new Date().toISOString(), error: "empty wake refused" };
    } else {
      delivery = await postWake(event.id, rawText);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ event, delivery }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.error(`reference-outbound-bridge listening 127.0.0.1:${port} (host-local LaunchAgent stays on Mini)`);
});
