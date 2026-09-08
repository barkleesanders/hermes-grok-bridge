#!/usr/bin/env node
/**
 * hermes-grok-bridge — zero-dep stdio MCP server
 * Content-Length framed JSON-RPC over stdin/stdout.
 * Domain: HermesEvent, GrokWake, Subscription, BridgeDelivery
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const VERSION = "0.1.0";
const UA = `hermes-grok-bridge/${VERSION}`;

const DEFAULT_OUTBOUND = "on_session_end,on_session_finalize";

/** @type {number} */
let lastWakeAt = 0;

function env(name, fallback = "") {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function allowedKinds() {
  const raw = env("HERMES_OUTBOUND_EVENTS", DEFAULT_OUTBOUND);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cosRateMs() {
  const sec = Number(env("HERMES_OUTBOUND_COS_RATE", "5"));
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : 5000;
}

function headerGet(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/**
 * @param {object} raw
 * @param {Record<string, string>|undefined} headers
 * @returns {object} HermesEvent
 */
function normalizeHermesEvent(raw, headers) {
  const body = raw && typeof raw === "object" ? raw : {};
  const kind =
    headerGet(headers, "X-Hermes-Event") ||
    body.hook_event_name ||
    body.kind ||
    "unknown";
  const deliveryId =
    headerGet(headers, "X-Hermes-Delivery") ||
    body.delivery_id ||
    body.deliveryId;
  const id = deliveryId || body.id || randomUUID();
  const sessionId = body.session_id || body.sessionId;
  const profile = body.profile;
  const toolName = body.tool_name || body.toolName;
  const timestamp = body.timestamp;
  const cwd = body.cwd;
  const extra = body.extra;
  return {
    id: String(id),
    kind: String(kind),
    ...(sessionId != null ? { sessionId: String(sessionId) } : {}),
    ...(profile != null ? { profile: String(profile) } : {}),
    ...(toolName != null ? { toolName: String(toolName) } : {}),
    ...(deliveryId != null ? { deliveryId: String(deliveryId) } : {}),
    ...(timestamp != null ? { timestamp: String(timestamp) } : {}),
    ...(cwd != null ? { cwd: String(cwd) } : {}),
    ...(extra != null ? { extra } : {}),
    raw: body,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} args
 * @returns {Promise<object>} BridgeDelivery
 */
async function postGrokWake(args = {}) {
  const url = env("GROK_WAKE_URL");
  const token = env("GROK_WAKE_TOKEN");
  const at = new Date().toISOString();
  if (!url) {
    return {
      status: "failed",
      error: "GROK_WAKE_URL not set",
      at,
      mode: "primary",
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.targetAgentId ? { targetAgentId: args.targetAgentId } : {}),
      ...(args.hermesEventId ? { hermesEventId: args.hermesEventId } : {}),
    };
  }

  const gap = cosRateMs();
  const wait = lastWakeAt + gap - Date.now();
  if (wait > 0) await sleep(wait);

  const obj = args.body != null && typeof args.body === "object" ? args.body : null;
  const hasKeys = !!(obj && Object.keys(obj).length > 0);
  const reason = args.reason ? String(args.reason) : "";
  if (!hasKeys && !reason) {
    return {
      status: "skipped",
      error: "empty wake refused; pass contentful body or reason",
      at,
      mode: "primary",
      ...(args.targetAgentId ? { targetAgentId: args.targetAgentId } : {}),
      ...(args.hermesEventId ? { hermesEventId: args.hermesEventId } : {}),
    };
  }
  const bodyStr = hasKeys
    ? JSON.stringify(obj)
    : `[hermes-grok-bridge]\n${reason}`;
  const contentType = hasKeys ? "application/json" : "text/plain; charset=utf-8";

  async function attempt(mode, headers) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: ac.signal,
      });
      clearTimeout(timer);
      return { status: res.status, ok: res.ok, mode };
    } catch (e) {
      clearTimeout(timer);
      return {
        status: 0,
        ok: false,
        mode,
        error: e?.name === "AbortError" ? "timeout 8s" : String(e?.message || e),
      };
    }
  }

  const primaryHeaders = {
    "Content-Type": contentType,
    "User-Agent": UA,
  };
  if (token) {
    primaryHeaders.Authorization = `Bearer ${token}`;
    primaryHeaders["X-Automation-Key"] = token;
  }

  let result = await attempt("primary", primaryHeaders);
  if (result.status === 401 && token) {
    result = await attempt("webhook-key", {
      "Content-Type": contentType,
      "X-Webhook-Key": token,
      "User-Agent": UA,
    });
  }

  lastWakeAt = Date.now();

  const delivery = {
    status: result.ok ? "sent" : "failed",
    at: new Date().toISOString(),
    mode: result.mode,
  };
  if (result.status) delivery.httpStatus = result.status;
  if (result.error) delivery.error = result.error;
  else if (!result.ok)
    delivery.error = `HTTP ${result.status || "error"}`;
  if (args.reason) delivery.reason = args.reason;
  if (args.targetAgentId) delivery.targetAgentId = args.targetAgentId;
  if (args.hermesEventId) delivery.hermesEventId = args.hermesEventId;
  return delivery;
}

async function ingestHermesEvent(args = {}) {
  const event = normalizeHermesEvent(args.raw ?? args, args.headers);
  const allowed = allowedKinds();
  if (!allowed.includes(event.kind)) {
    return {
      event,
      delivery: {
        status: "skipped",
        at: new Date().toISOString(),
        error: `kind ${event.kind} not in HERMES_OUTBOUND_EVENTS`,
      },
    };
  }
  const wakeBody = args.wakeBody;
  const contentful =
    wakeBody != null && typeof wakeBody === "object" && Object.keys(wakeBody).length > 0;
  if (!contentful) {
    return {
      event,
      delivery: {
        status: "skipped",
        at: new Date().toISOString(),
        error: "empty wakeBody refused",
      },
    };
  }
  const delivery = await postGrokWake({
    hermesEventId: event.id,
    reason: `hermes:${event.kind}`,
    body: wakeBody,
    targetAgentId: args.targetAgentId || env("GROK_DEFAULT_AGENT_ID") || undefined,
  });
  return { event, delivery };
}

async function postHermesInbound(args = {}) {
  const base = env("HERMES_WEBHOOK_BASE");
  const name = args.name || env("HERMES_WEBHOOK_NAME");
  const at = new Date().toISOString();
  if (!base) {
    return {
      status: "failed",
      error:
        "HERMES_WEBHOOK_BASE not set. Grok Linux box cannot hit Mini localhost; use Tailscale/public URL.",
      at,
    };
  }
  if (!name) {
    return { status: "failed", error: "webhook name required", at };
  }
  const url = `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(name)}`;
  const secret = env("HERMES_WEBHOOK_SECRET");
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": UA,
  };
  if (secret) headers["X-Hermes-Secret"] = secret;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(args.body ?? {}),
      signal: ac.signal,
    });
    clearTimeout(timer);
    return {
      status: res.ok ? "sent" : "failed",
      httpStatus: res.status,
      at: new Date().toISOString(),
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      status: "failed",
      error: e?.name === "AbortError" ? "timeout 8s" : String(e?.message || e),
      at: new Date().toISOString(),
    };
  }
}

function hermesCli() {
  return env("HERMES_CLI", "hermes");
}

function runHermes(argv) {
  return new Promise((resolve) => {
    const bin = hermesCli();
    const child = spawn(bin, argv, { env: process.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({
        exitCode: 127,
        stdout,
        stderr:
          stderr +
          (stderr ? "\n" : "") +
          `hermes CLI not available (${bin}): ${err.message}`,
      });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function hermesWebhookList() {
  return runHermes(["webhook", "list"]);
}

async function hermesWebhookSubscribe(args = {}) {
  const argv = ["webhook", "subscribe"];
  if (args.name) argv.push(String(args.name));
  if (args.events) {
    const ev = Array.isArray(args.events) ? args.events.join(",") : String(args.events);
    argv.push("--events", ev);
  }
  if (args.prompt) argv.push("--prompt", String(args.prompt));
  if (args.deliver) argv.push("--deliver", String(args.deliver));
  if (args.script) argv.push("--script", String(args.script));
  if (args.secret) argv.push("--secret", String(args.secret));
  if (args.deliverOnly) argv.push("--deliver-only");
  return runHermes(argv);
}

async function hermesWebhookRemove(args = {}) {
  if (!args.name) return { exitCode: 1, stdout: "", stderr: "name required" };
  return runHermes(["webhook", "remove", String(args.name)]);
}

async function hermesWebhookTest(args = {}) {
  if (!args.name) return { exitCode: 1, stdout: "", stderr: "name required" };
  return runHermes(["webhook", "test", String(args.name)]);
}

const TOOLS = [
  {
    name: "normalize_hermes_event",
    description:
      "Normalize raw Hermes outbound JSON (+ optional headers) into HermesEvent. Maps hook_event_name / X-Hermes-Event → kind.",
    inputSchema: {
      type: "object",
      properties: {
        raw: { type: "object", description: "Raw outbound JSON body" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional HTTP headers map",
        },
      },
      required: ["raw"],
    },
  },
  {
    name: "post_grok_wake",
    description:
      "POST a contentful wake to GROK_WAKE_URL. Empty {} is refused (skipped) unless body has keys or reason is set (posted as text/plain). Bearer+X-Automation-Key; on 401 retry X-Webhook-Key. Rate-limited; fail-open.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "object", description: "Wake JSON body. Empty {} is skipped; pass keys or reason." },
        reason: { type: "string" },
        targetAgentId: { type: "string" },
        hermesEventId: { type: "string" },
      },
    },
  },
  {
    name: "ingest_hermes_event",
    description:
      "Normalize then post_grok_wake if kind is in HERMES_OUTBOUND_EVENTS (default on_session_end,on_session_finalize); else skipped.",
    inputSchema: {
      type: "object",
      properties: {
        raw: { type: "object" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        wakeBody: { type: "object" },
        targetAgentId: { type: "string" },
      },
      required: ["raw"],
    },
  },
  {
    name: "post_hermes_inbound",
    description:
      "POST JSON to HERMES_WEBHOOK_BASE/webhooks/<name>. Box cannot hit Mini localhost — needs Tailscale/public URL.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        body: { type: "object" },
      },
    },
  },
  {
    name: "hermes_webhook_list",
    description: "Spawn `hermes webhook list` (or HERMES_CLI).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hermes_webhook_subscribe",
    description:
      "Spawn hermes webhook subscribe with name/events/prompt/deliver/script/secret/deliverOnly.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        events: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        prompt: { type: "string" },
        deliver: { type: "string" },
        script: { type: "string" },
        secret: { type: "string" },
        deliverOnly: { type: "boolean" },
      },
    },
  },
  {
    name: "hermes_webhook_remove",
    description: "Spawn hermes webhook remove <name>.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "hermes_webhook_test",
    description: "Spawn hermes webhook test <name>.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "normalize_hermes_event":
      return normalizeHermesEvent(args.raw, args.headers);
    case "post_grok_wake":
      return postGrokWake(args);
    case "ingest_hermes_event":
      return ingestHermesEvent(args);
    case "post_hermes_inbound":
      return postHermesInbound(args);
    case "hermes_webhook_list":
      return hermesWebhookList();
    case "hermes_webhook_subscribe":
      return hermesWebhookSubscribe(args);
    case "hermes_webhook_remove":
      return hermesWebhookRemove(args);
    case "hermes_webhook_test":
      return hermesWebhookTest(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const frame = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  process.stdout.write(frame);
}

function makeResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  const { id, method, params } = msg;
  if (id === undefined || id === null) {
    // notification — ignore
    return;
  }
  try {
    if (method === "initialize") {
      sendMessage(
        makeResult(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "hermes-grok-bridge", version: VERSION },
        })
      );
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      sendMessage(makeResult(id, { tools: TOOLS }));
      return;
    }
    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      try {
        const result = await callTool(toolName, toolArgs);
        sendMessage(
          makeResult(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          })
        );
      } catch (e) {
        sendMessage(
          makeResult(id, {
            content: [{ type: "text", text: String(e?.message || e) }],
            isError: true,
          })
        );
      }
      return;
    }
    if (method === "ping") {
      sendMessage(makeResult(id, {}));
      return;
    }
    sendMessage(makeError(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    sendMessage(makeError(id, -32603, String(e?.message || e)));
  }
}

// Content-Length framed reader
let buf = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buf.subarray(0, headerEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      // try newline-delimited fallback for a single line
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.subarray(0, nl).toString("utf8").trim();
      buf = buf.subarray(nl + 1);
      if (line) {
        try {
          void handleMessage(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const body = buf.subarray(start, start + len).toString("utf8");
    buf = buf.subarray(start + len);
    try {
      void handleMessage(JSON.parse(body));
    } catch {
      /* ignore parse errors */
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
