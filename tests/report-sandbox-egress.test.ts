import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// The isolated session's egress proxy (scripts/report-sandbox/egress-proxy.mjs):
// the fetch container's only way out, to GitHub and the npm registry by
// HTTPS at a public address. Nothing here needs the internet: what is
// checked is what it refuses.
const script = "scripts/report-sandbox/egress-proxy.mjs";
const { privateAddress } = (await import(`../${script}`)) as { privateAddress: (address: string) => boolean };

test("addresses on this computer or its network are not public", () => {
  for (const address of [
    "127.0.0.1", "10.0.2.2", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:192.168.1.1", "::ffff:127.0.0.1", "2001:db8::1", "2002:c0a8:0101::1", "64:ff9b::a00:1", "not an address",
  ])
    assert.equal(privateAddress(address), true, address);
  for (const address of ["140.82.112.3", "104.16.24.34", "172.32.0.1", "::ffff:140.82.112.3", "2606:4700::6810:1822", "2a04:4e42::223"])
    assert.equal(privateAddress(address), false, address);
});

let folder: string;
let proxy: ChildProcess;
const socket = () => join(folder, "s");

before(async () => {
  folder = await mkdtemp(join(tmpdir(), "egress-"));
  // localhost is allowed by name here, to show the address check refuses it anyway.
  proxy = spawn(process.execPath, [script, socket(), join(folder, "log"), "localhost,github.com"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(socket()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(socket()), "the egress proxy did not start");
});

after(async () => {
  proxy?.kill();
  await rm(folder, { recursive: true, force: true });
});

const ask = (request: string) =>
  new Promise<string>((resolve, reject) => {
    const client = connect(socket(), () => client.write(request));
    client.once("data", (data) => {
      client.destroy();
      resolve(String(data).split("\r\n")[0]);
    });
    client.on("error", reject);
  });

test("the egress proxy refuses other hosts, other ports, private addresses and plain HTTP", async () => {
  assert.match(await ask("CONNECT example.com:443 HTTP/1.1\r\n\r\n"), / 403 /);
  assert.match(await ask("CONNECT github.com:22 HTTP/1.1\r\n\r\n"), / 403 /);
  assert.match(await ask("CONNECT localhost:443 HTTP/1.1\r\n\r\n"), / 403 /);
  assert.match(await ask("GET http://github.com/ HTTP/1.1\r\nHost: github.com\r\n\r\n"), / 403 /);
  const log = readFileSync(join(folder, "log"), "utf8");
  assert.match(log, /refused example\.com/);
  assert.match(log, /refused github\.com:22/);
  assert.match(log, /refused localhost \((?:not public|no address)\)/);
  // A refused plain request is logged without its query string.
  assert.match(log, /refused plain GET http:\/\/github\.com\//);
});
