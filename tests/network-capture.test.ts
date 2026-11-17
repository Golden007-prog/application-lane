import { test } from "node:test";
import assert from "node:assert/strict";

let event: (source: any, method: string, params: any) => void;
let commands: string[] = [];
let response: Promise<any> = Promise.resolve({ body: "finished body", base64Encoded: false });
const url = "https://jobs.example.test/apply";
(globalThis as any).chrome = {
  runtime: { getManifest: () => ({ version: "test" }) },
  debugger: {
    attach: async () => {}, detach: async () => {},
    onEvent: { addListener: (listener: typeof event) => { event = listener; } },
    sendCommand: async (_target: any, method: string) => {
      commands.push(method);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.getResourceTree") return { frameTree: { frame: { id: "main", url }, resources: [
        { url: `${url}/widget.js`, type: "Script", mimeType: "text/javascript" },
        { url: `${url}/private.js?access_token=private`, type: "Script", mimeType: "text/javascript" },
      ] } };
      if (method === "Page.getResourceContent") return { content: "cached resource", base64Encoded: false };
      if (method === "Network.getResponseBody") return response;
      return {};
    },
  },
};
const { startCapture, stopCapture, captureHar } = await import("../src/extension/network-capture");

test("late capture recovers cached resources without a reload or network request", async () => {
  commands = [];
  await startCapture(10, false);
  const capture = await captureHar(10);
  assert.equal(capture?.fromLoad, false);
  assert.equal(capture?.recovered, 2);
  assert.equal(capture?.missing, 1);
  const entries = (capture?.har as any).log.entries;
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry: any) => entry._fromCacheRecovery));
  assert.ok(!JSON.stringify(entries).includes("access_token"));
  assert.ok(commands.includes("Page.enable"));
  assert.ok(commands.every((method) => !/navigate|reload|loadNetworkResource|fetch/i.test(method)));
  await stopCapture(10);
});

test("a report waits for in-flight response bodies and strips credential headers", async () => {
  let finish!: (body: any) => void;
  response = new Promise((resolve) => { finish = resolve; });
  await startCapture(11, true);
  event({ tabId: 11 }, "Network.requestWillBeSent", { requestId: "request", type: "Fetch", request: {
    method: "GET", url: `${url}/data`, headers: { Cookie: "private", Authorization: "private", "X-Api-Key": "private", Accept: "application/json" },
  } });
  event({ tabId: 11 }, "Network.responseReceived", { requestId: "request", response: { status: 200, mimeType: "application/json", headers: { "Set-Cookie": "private" } } });
  event({ tabId: 11 }, "Network.loadingFinished", { requestId: "request", encodedDataLength: 10 });
  const reporting = captureHar(11);
  finish({ body: '{"result":"complete"}', base64Encoded: false });
  const capture = await reporting;
  const entries = (capture?.har as any).log.entries;
  const data = entries.find((entry: any) => entry.request.url.endsWith("/data"));
  assert.equal(data.response.content.text, '{"result":"complete"}');
  assert.deepEqual(data.request.headers, [{ name: "Accept", value: "application/json" }]);
  assert.deepEqual(data.response.headers, []);
  await stopCapture(11);
});

test("a sign-in's password, one-time code and token are not kept in a capture", async () => {
  response = Promise.resolve({ body: '{"user":{"name":"Alex"},"access_token":"private-token","expires_in":3600}', base64Encoded: false });
  await startCapture(12, true);
  event({ tabId: 12 }, "Network.requestWillBeSent", { requestId: "login", type: "XHR", request: {
    method: "POST", url: `${url}/login?session=private-session&step=2`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    postData: "email=alex%40example.test&password=private-password&otp=123456&remember=1",
  } });
  event({ tabId: 12 }, "Network.responseReceived", { requestId: "login", response: { status: 200, mimeType: "application/json", headers: {} } });
  event({ tabId: 12 }, "Network.loadingFinished", { requestId: "login", encodedDataLength: 10 });
  const capture = await captureHar(12);
  const login = (capture?.har as any).log.entries.find((entry: any) => entry.request.url.includes("/login"));
  const saved = JSON.stringify(login);
  assert.doesNotMatch(saved, /private-password|123456|private-token|private-session/);
  // What a replay matches on, and what reproduces the form, is kept.
  assert.match(login.request.url, /step=2/);
  assert.match(login.request.postData.text, /email=alex%40example.test/);
  assert.match(login.request.postData.text, /remember=1/);
  assert.equal(JSON.parse(login.response.content.text).user.name, "Alex");
  assert.equal(JSON.parse(login.response.content.text).expires_in, 3600);
  await stopCapture(12);
});

test("credentials are redacted in JSON, form and multipart bodies, and nothing else is changed", async () => {
  const { redactBody, redactCapturedURL } = await import("../src/extension/network-capture");
  assert.deepEqual(JSON.parse(redactBody('{"login":{"username":"alex","newPassword":"p1","mfaCode":"9"},"items":[{"csrfToken":"t"}],"zip":"85004"}', "application/json")), {
    login: { username: "alex", newPassword: "[redacted]", mfaCode: "[redacted]" },
    items: [{ csrfToken: "[redacted]" }],
    zip: "85004",
  });
  assert.equal(redactBody("first=Alex&api_key=k&countryCode=US", "application/x-www-form-urlencoded"), "first=Alex&api_key=%5Bredacted%5D&countryCode=US");
  const multipart = '--b\r\nContent-Disposition: form-data; name="first"\r\n\r\nAlex\r\n--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nsecret-value\r\n--b--\r\n';
  const kept = redactBody(multipart, "multipart/form-data; boundary=b");
  assert.doesNotMatch(kept, /secret-value/);
  assert.match(kept, /\r\n\r\nAlex\r\n/);
  // Plain text, and a body with nothing secret, are left as they were.
  assert.equal(redactBody("just some text", "text/plain"), "just some text");
  assert.equal(redactBody('{"a":1}', "application/json"), '{"a":1}');
  assert.equal(redactCapturedURL(`${url}/options?countryCode=US&key=field_7`), `${url}/options?countryCode=US&key=field_7`);
  assert.equal(redactCapturedURL(`${url}/resume?token=abc&lang=en`), `${url}/resume?token=%5Bredacted%5D&lang=en`);
});
