import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// The isolated session's token proxy (scripts/report-sandbox/token-proxy.mjs):
// the container holds only a stand-in token, and this adds the real one on
// the way out. Here its upstream is a local server standing in for the API.
const TOKEN = "sk-ant-oat01-real-token-for-the-test";
let folder: string;
let proxy: ChildProcess;
let upstream: Server;
let seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];

before(async () => {
  folder = await mkdtemp(join(tmpdir(), "token-proxy-"));
  await writeFile(join(folder, "token"), `${TOKEN}\n`, { mode: 0o600 });
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      // Streamed in two parts, as server-sent events are.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\n\n");
      setTimeout(() => res.end("event: message_stop\n\n"), 20);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  proxy = spawn(process.execPath, [
    "scripts/report-sandbox/token-proxy.mjs",
    join(folder, "sock"),
    join(folder, "token"),
    join(folder, "proxy.log"),
    `http://127.0.0.1:${port}`,
  ], { stdio: "ignore" });
  for (let waited = 0; waited < 50 && !existsSync(join(folder, "sock")); waited++) await new Promise((resolve) => setTimeout(resolve, 100));
});

after(async () => {
  proxy?.kill();
  upstream?.close();
  await rm(folder, { recursive: true, force: true });
});

// A request as Claude Code in the container makes it: over the socket, with
// the stand-in token.
const call = (method: string, path: string, headers: Record<string, string> = {}, body = "") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: join(folder, "sock"), method, path, headers: { authorization: "Bearer stand-in", "x-api-key": "stand-in", ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });

test("a Messages request goes out with the real token, and only it", async () => {
  seen = [];
  const reply = await call("POST", "/v1/messages?beta=true", { "content-type": "application/json", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" }, '{"model":"claude"}');
  assert.equal(reply.status, 200);
  assert.equal(reply.body, "event: message_start\n\nevent: message_stop\n\n");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/v1/messages?beta=true");
  assert.equal(seen[0].body, '{"model":"claude"}');
  assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].headers["x-api-key"], undefined);
  assert.deepEqual(String(seen[0].headers["anthropic-beta"]).split(","), ["fine-grained-tool-streaming-2025-05-14", "oauth-2025-04-20"]);
  // Counting tokens is passed on too.
  assert.equal((await call("POST", "/v1/messages/count_tokens", {}, "{}")).status, 200);
});

test("anything but the Messages API is refused, and never reaches the API", async () => {
  seen = [];
  for (const [method, path] of [
    ["GET", "/v1/models"],
    ["POST", "/v1/files"],
    ["GET", "/v1/messages"],
    ["POST", "/api/oauth/profile"],
    ["POST", "/v1/messages/../files"],
  ])
    assert.equal((await call(method, path, {}, method === "POST" ? "{}" : "")).status, 403, `${method} ${path}`);
  assert.equal(seen.length, 0);
});

test("the token is never written to the log or sent back", async () => {
  const reply = await call("GET", "/v1/models");
  assert.doesNotMatch(reply.body, /real-token/);
  const log = readFileSync(join(folder, "proxy.log"), "utf8");
  assert.doesNotMatch(log, /real-token|stand-in/);
  assert.match(log, /refused GET \/v1\/models/);
});

test("a socket path too long to hold is refused, not silently cut short", async () => {
  const child = spawn(process.execPath, [
    "scripts/report-sandbox/token-proxy.mjs",
    join(folder, "x".repeat(120), "api.sock"),
    join(folder, "token"),
    join(folder, "long.log"),
  ], { stdio: "ignore" });
  const [code] = await once(child, "exit");
  assert.equal(code, 2);
});
