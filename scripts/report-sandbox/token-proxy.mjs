// Runs beside the isolated session's container, as lane-reports and outside
// it, so the Claude token never enters the container (lane-reports-agent).
// The container has no network; Claude Code in it is pointed at this proxy
// (ANTHROPIC_BASE_URL) through a socket file mounted into it, with a stand-in
// token. This adds the real token and passes on only what Claude Code needs
// of the Messages API; anything else is refused. What it passes or refuses
// is logged by method, path and status only: never a header or a body.
//
//   node token-proxy.mjs <socket> <token file> <log file> [<upstream>]
//
// The upstream defaults to https://api.anthropic.com (tests point it at a
// local server).
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const [socket, tokenFile, logFile, upstreamText = "https://api.anthropic.com"] = process.argv.slice(2);
if (!socket || !tokenFile || !logFile) {
  console.error("token-proxy: <socket> <token file> <log file> [<upstream>]");
  process.exit(2);
}
// A socket's path has room for about 107 bytes; a longer one is silently cut
// short, and the container would look for it under a name that is not there.
if (Buffer.byteLength(socket) > 100) {
  console.error(`token-proxy: the socket's path is too long: ${socket}`);
  process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();
const upstream = new URL(upstreamText);
const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
const log = (line) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* a log that cannot be written stops nothing */
  }
};

// The Messages API, and counting tokens for it: what Claude Code calls
// through a gateway (ANTHROPIC_BASE_URL). A query string is allowed
// ("?beta=true"); any other path or method is not.
const allowed = (method, path) =>
  method === "POST" && /^\/v1\/messages(\/count_tokens)?(\?[\w=&.-]*)?$/.test(path);

// Headers passed on: the request's own, less any credential and the
// connection's, with the real token. A subscription token needs the OAuth
// beta flag, which Claude Code sends only when it holds the token itself.
function forwardedHeaders(headers, token, host) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^(authorization|x-api-key|host|connection|proxy-authorization|cookie)$/i.test(name)) continue;
    out[name] = value;
  }
  out.host = host;
  out.authorization = `Bearer ${token}`;
  const betas = String(out["anthropic-beta"] || "").split(",").map((beta) => beta.trim()).filter(Boolean);
  if (!betas.includes("oauth-2025-04-20")) betas.push("oauth-2025-04-20");
  out["anthropic-beta"] = betas.join(",");
  return out;
}

const server = createServer((req, res) => {
  const path = req.url || "/";
  if (!allowed(req.method, path)) {
    log(`refused ${req.method} ${path.split("?")[0]}`);
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: "Not passed on by the isolated session's proxy." } }));
    req.resume();
    return;
  }
  const outgoing = send(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      path,
      headers: forwardedHeaders(req.headers, token, upstream.host),
    },
    (reply) => {
      log(`${req.method} ${path.split("?")[0]} ${reply.statusCode}`);
      // Streamed as it arrives: Claude Code reads server-sent events.
      res.writeHead(reply.statusCode || 502, reply.headers);
      reply.pipe(res);
    },
  );
  outgoing.on("error", (error) => {
    log(`${req.method} ${path.split("?")[0]} failed: ${error.code || "error"}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "The isolated session's proxy could not reach the API." } }));
  });
  req.pipe(outgoing);
});

rmSync(socket, { force: true });
server.listen(socket, () => log("listening"));
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
