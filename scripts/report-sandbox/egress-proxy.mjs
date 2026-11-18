// Runs beside the isolated session's fetch container, as lane-reports and
// outside it (lane-reports-agent). The fetch container has no network: git
// and npm in it reach the internet only through this proxy, over a socket
// file mounted into it, and only to the hosts they need (GitHub for the
// clone, the npm registry for packages), by HTTPS, at a public address. Not
// this computer, its network, or anywhere else. What it passes on or refuses
// is logged by host only.
//
//   node egress-proxy.mjs <socket> <log file> [<allowed host>,…]
import { appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect, isIP } from "node:net";
import { lookup } from "node:dns/promises";

// An address on this computer, its network, or otherwise not public.
export function privateAddress(address) {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (kind === 6) {
    const plain = address.toLowerCase();
    const mapped = plain.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]);
    // Public only in global unicast (2000::/3), and not documentation's or
    // 6to4's (which carries an IPv4 address of any kind).
    return !/^[23][0-9a-f]{0,3}:/.test(plain) || /^2001:0?db8:/.test(plain) || /^2002:/.test(plain);
  }
  return true;
}

// Run as a program; imported (by the tests) it only lends privateAddress.
if (process.argv[1] && /egress-proxy\.mjs$/.test(process.argv[1])) main();

function main() {
  const [socket, logFile, hostsText = "github.com,registry.npmjs.org"] = process.argv.slice(2);
  if (!socket || !logFile) {
    console.error("egress-proxy: <socket> <log file> [<allowed host>,…]");
    process.exit(2);
  }
  if (Buffer.byteLength(socket) > 100) {
    console.error(`egress-proxy: the socket's path is too long: ${socket}`);
    process.exit(2);
  }
  const allowed = new Set(hostsText.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  const log = (line) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* a log that cannot be written stops nothing */
    }
  };

  const refuse = (client, why) => {
    log(`refused ${why}`);
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  };

  const server = createServer((req, res) => {
    // Plain HTTP is not passed on: git and npm use HTTPS.
    log(`refused plain ${req.method} ${String(req.url).split("?")[0].slice(0, 100)}`);
    res.writeHead(403).end();
  });
  server.on("connect", async (req, client, head) => {
    const [host, portText] = String(req.url).split(":");
    const name = (host || "").toLowerCase();
    if (portText !== "443") return refuse(client, `${name}:${portText}`);
    if (!allowed.has(name)) return refuse(client, name);
    let addresses;
    try {
      addresses = (await lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      return refuse(client, `${name} (no address)`);
    }
    if (!addresses.length || addresses.some(privateAddress)) return refuse(client, `${name} (not public)`);
    const upstream = connect({ host: addresses[0], port: 443 }, () => {
      log(`CONNECT ${name}`);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });

  rmSync(socket, { force: true });
  server.listen(socket, () => log(`listening, allowing ${[...allowed].join(", ")}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
