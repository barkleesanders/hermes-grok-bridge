#!/usr/bin/env node
/**
 * MCP stdio smoke: initialize → tools/list → tools/call normalize_hermes_event
 * Optionally post_grok_wake only if GROK_WAKE_URL is set.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "server", "index.mjs");

function frame(obj) {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function parseFrames(buf) {
  const messages = [];
  let rest = buf;
  while (true) {
    const idx = rest.indexOf("\r\n\r\n");
    if (idx === -1) break;
    const header = rest.slice(0, idx).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) break;
    const len = parseInt(m[1], 10);
    const start = idx + 4;
    if (rest.length < start + len) break;
    const body = rest.slice(start, start + len).toString("utf8");
    rest = rest.slice(start + len);
    messages.push(JSON.parse(body));
  }
  return { messages, rest };
}

const child = spawn("node", [serverPath], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let out = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
let stderr = "";

child.stderr.on("data", (d) => {
  stderr += d.toString();
});

child.stdout.on("data", (chunk) => {
  out = Buffer.concat([out, chunk]);
  const { messages, rest } = parseFrames(out);
  out = rest;
  for (const msg of messages) {
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
  });
}

const sample = {
  hook_event_name: "on_session_end",
  profile: "default",
  session_id: "sess_redacted",
  cwd: "/tmp",
  delivery_id: "00000000-0000-0000-0000-000000000001",
  timestamp: "2026-09-02T00:00:00Z",
  extra: { session_id: "sess_redacted", completed: true, failed: false },
};

const results = { initialize: null, toolsList: null, normalize: null, postWake: "SKIP (GROK_WAKE_URL unset)" };

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "0.0.1" },
  });
  results.initialize = init.result?.serverInfo || init;
  child.stdin.write(
    frame({ jsonrpc: "2.0", method: "notifications/initialized" })
  );

  const list = await request("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  results.toolsList = names;

  const call = await request("tools/call", {
    name: "normalize_hermes_event",
    arguments: { raw: sample },
  });
  const text = call.result?.content?.[0]?.text;
  results.normalize = text ? JSON.parse(text) : call.result?.structuredContent || call;

  if (process.env.GROK_WAKE_URL) {
    const wake = await request("tools/call", {
      name: "post_grok_wake",
      arguments: { reason: "smoke-test" },
    });
    const wtext = wake.result?.content?.[0]?.text;
    results.postWake = wtext ? JSON.parse(wtext) : wake.result;
  }

  console.log(JSON.stringify({ ok: true, results, stderr: stderr || undefined }, null, 2));
  child.kill();
  process.exit(0);
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e), results, stderr }, null, 2));
  child.kill();
  process.exit(1);
}
