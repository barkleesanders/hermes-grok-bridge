import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptRoot = process.env.BRIDGE_TEST_ROOT || root;

async function fixture(t, { retry = false } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ headers: req.headers, body });
    res.writeHead(retry && requests.length === 1 ? 401 : 200);
    res.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function launch(t, script, env) {
  // Deliberately exclude inherited webhook credentials and service endpoints.
  const child = spawn(process.execPath, [path.join(scriptRoot, script)], {
    cwd: scriptRoot,
    env: {
      PATH: process.env.PATH,
      GROK_WAKE_TOKEN: "local-test-token",
      HERMES_OUTBOUND_COS_RATE: "0",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    child.kill();
    await exited;
  });
  return child;
}

async function mcp(t, url, newline = false) {
  const child = launch(t, "server/index.mjs", { GROK_WAKE_URL: url });
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (newline) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const message = JSON.parse(buffer.subarray(0, end).toString());
        buffer = buffer.subarray(end + 1);
        pending.get(message.id)?.(message);
        continue;
      }
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) break;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString());
      assert.ok(match, "valid MCP response framing");
      const size = Number(match[1]);
      if (buffer.length < end + 4 + size) break;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
      buffer = buffer.subarray(end + 4 + size);
      pending.get(message.id)?.(message);
    }
  });
  function request(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 4000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      });
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      child.stdin.write(
        newline ? `${body}\n` : `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
  }
  const init = await request("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(init.result.serverInfo.name, "hermes-grok-bridge");
  const list = await request("tools/list", {});
  assert.equal(list.result.tools.length, 8);
  return async (name, args) => {
    const response = await request("tools/call", { name, arguments: args });
    assert.ok(!response.result.isError, JSON.stringify(response));
    return response.result.structuredContent;
  };
}

test("MCP standard newline transport initializes and rejects an empty wake", async (t) => {
  const sink = await fixture(t);
  const call = await mcp(t, sink.url, true);
  assert.equal((await call("post_grok_wake", {})).status, "skipped");
  assert.equal(sink.requests.length, 0);
});

test("default smoke never sends a live wake even with an inherited URL", async (t) => {
  const sink = await fixture(t);
  const child = launch(t, "scripts/mcp-smoke.mjs", { GROK_WAKE_URL: sink.url });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(JSON.parse(output).results.postWake, /^SKIP/);
  assert.equal(sink.requests.length, 0);
});

test("MCP refuses empty bodies, whitespace-only reasons, and arrays without HTTP", async (t) => {
  const sink = await fixture(t);
  const call = await mcp(t, sink.url);
  for (const args of [{}, { body: {} }, { reason: " \n\t " }, { body: [""] }]) {
    assert.equal((await call("post_grok_wake", args)).status, "skipped", JSON.stringify(args));
  }
  for (const wakeBody of [undefined, {}, [""]]) {
    const result = await call("ingest_hermes_event", {
      raw: { hook_event_name: "on_session_end" },
      wakeBody,
    });
    assert.equal(result.delivery.status, "skipped");
  }
  assert.equal(sink.requests.length, 0);
});

test("MCP preserves JSON and retries 401 with the alternate auth only", async (t) => {
  const sink = await fixture(t, { retry: true });
  const call = await mcp(t, sink.url);
  const body = { text: "Synthetic local wake" };
  const result = await call("post_grok_wake", { body });
  assert.equal(result.status, "sent");
  assert.equal(result.mode, "webhook-key");
  assert.equal(sink.requests.length, 2);
  for (const req of sink.requests) {
    assert.equal(req.body, JSON.stringify(body));
    assert.equal(req.headers["content-type"], "application/json");
  }
  assert.equal(sink.requests[0].headers.authorization, "Bearer local-test-token");
  assert.equal(sink.requests[1].headers.authorization, undefined);
  assert.equal(sink.requests[1].headers["x-automation-key"], undefined);
  assert.equal(sink.requests[1].headers["x-webhook-key"], "local-test-token");
});

test("MCP sends reason text and gates normalized events by kind", async (t) => {
  const sink = await fixture(t);
  const call = await mcp(t, sink.url);
  assert.equal((await call("post_grok_wake", { reason: "  Local reason  " })).status, "sent");
  assert.equal(sink.requests[0].body, "[hermes-grok-bridge]\nLocal reason");
  assert.match(sink.requests[0].headers["content-type"], /^text\/plain/);
  const ignored = await call("ingest_hermes_event", {
    raw: { kind: "other" },
    wakeBody: { text: "ignore" },
  });
  assert.equal(ignored.delivery.status, "skipped");
  const accepted = await call("ingest_hermes_event", {
    raw: { hook_event_name: "on_session_end", delivery_id: "local-delivery" },
    wakeBody: { text: "accepted" },
  });
  assert.equal(accepted.delivery.status, "sent");
  assert.equal(accepted.delivery.hermesEventId, "local-delivery");
  assert.equal(sink.requests.length, 2);
});

test("MCP reports failed delivery on upstream 503", async (t) => {
  const server = http.createServer((_, res) => {
    res.writeHead(503);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const call = await mcp(t, `http://127.0.0.1:${server.address().port}`);
  const result = await call("post_grok_wake", { reason: "local-only" });
  assert.equal(result.status, "failed");
  assert.equal(result.httpStatus, 503);
});

test("reference listener skips empty/disallowed events and preserves text across auth retry", async (t) => {
  const sink = await fixture(t, { retry: true });
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = launch(t, "scripts/reference-outbound-bridge.mjs", {
    GROK_WAKE_URL: sink.url,
    BRIDGE_PORT: String(port),
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("listener startup timeout")), 4000);
    child.stderr.on("data", (data) => {
      if (data.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  async function post(raw) {
    const response = await fetch(`http://127.0.0.1:${port}/hermes-events`, {
      method: "POST",
      body: JSON.stringify(raw),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  for (const raw of [
    { hook_event_name: "on_session_end" },
    { hook_event_name: "on_session_end", text: "  " },
    { kind: "other", text: "ignore" },
  ]) {
    assert.equal((await post(raw)).delivery.status, "skipped");
  }
  assert.equal(sink.requests.length, 0);
  assert.equal(
    (await post({ hook_event_name: "on_session_end", message: "  Local reference test  " }))
      .delivery.status,
    "sent",
  );
  assert.equal(sink.requests.length, 2);
  assert.equal(sink.requests[0].body, "[hermes-grok-bridge]\nLocal reference test");
  assert.equal(sink.requests[1].body, sink.requests[0].body);
  assert.equal(sink.requests[1].headers["x-webhook-key"], "local-test-token");
});
