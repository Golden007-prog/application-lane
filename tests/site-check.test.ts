import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSite, checkSites, siteOfAddress, type SiteCheck } from "../src/server/site-check";

// Every name resolves to a public address, without the network.
const publicLookup = async () => ["93.184.215.14"];

test("an opening's site is known from its address, its host, or the ATS its address names", () => {
  assert.equal(siteOfAddress("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_JR1")?.ats, "Workday");
  assert.equal(siteOfAddress("https://job-boards.greenhouse.io/acme/jobs/123")?.ats, "Greenhouse");
  assert.equal(siteOfAddress("https://jobs.lever.co/acme/123")?.ats, "Lever");
  // A careers page that embeds Greenhouse names its job ID.
  assert.deepEqual(siteOfAddress("https://www.example.com/company/careers/departments/job.8267709?gh_jid=8267709"), { ats: "Greenhouse", by: "parameter" });
  // Fabrikam's names its ATS outright.
  assert.equal(siteOfAddress("https://jobs.example.com/job/Intern/1451916833/?ats=successfactors")?.ats, "SuccessFactors");
  // A careers page of its own, with nothing to go on.
  assert.equal(siteOfAddress("https://careers.example.com/jobs/93894"), undefined);
});

test("a careers page is read for the ATS its links lead to", async () => {
  const pages: Record<string, { status: number; body: string; url?: string }> = {
    "https://careers.example.com/jobs/93894": { status: 200, body: '<a href="https://careers-acme.icims.com/jobs/93894/login">Apply</a>' },
    "https://careers.example.net/job/1": { status: 200, body: "<p>Apply on our own site.</p>" },
    "https://careers.example.org/job/2": { status: 302, body: "", url: "https://acme.wd1.myworkdayjobs.com/en-US/External/job/Intern_R1" },
  };
  const fetcher = (async (input: string | URL) => {
    const page = pages[String(input)];
    return new Response(page?.body ?? "", { status: page?.status ?? 404, headers: page?.url ? { location: page.url } : {} });
  }) as typeof fetch;
  assert.deepEqual(await checkSite("https://careers.example.com/jobs/93894", fetcher, publicLookup), { ats: "iCIMS", via: "https://careers-acme.icims.com/jobs/93894/login", by: "page" });
  assert.deepEqual(await checkSite("https://careers.example.net/job/1", fetcher, publicLookup), { by: "none" });
  assert.equal((await checkSite("https://careers.example.org/job/2", fetcher, publicLookup)).ats, "Workday");
  // Checked once each.
  let requests = 0;
  const counted = (async (input: string | URL) => (requests++, fetcher(input))) as typeof fetch;
  const cache = new Map<string, SiteCheck>();
  await checkSites(["https://careers.example.net/job/1", "https://careers.example.net/job/1", "https://jobs.lever.co/acme/1"], cache, counted, 6, publicLookup);
  await checkSites(["https://careers.example.net/job/1"], cache, counted, 6, publicLookup);
  assert.equal(requests, 1);
  assert.equal(cache.get("https://jobs.lever.co/acme/1")?.ats, "Lever");
});

test("a listing that names this computer or its network is never opened", async () => {
  const opened: string[] = [];
  const fetcher = (async (input: string | URL) => {
    opened.push(String(input));
    return new Response("", { status: 302, headers: { location: "http://192.168.1.1/admin" } });
  }) as typeof fetch;
  for (const url of [
    "http://localhost:4318/v1/profile",
    "http://127.0.0.1:4318/v1/profile",
    "http://192.168.1.1/",
    "http://10.0.0.8/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:4318/",
    "http://[::ffff:7f00:1]:4318/",
    "http://printer.local/",
    "http://2130706433/",
  ])
    assert.deepEqual(await checkSite(url, fetcher, publicLookup), { by: "none" }, url);
  assert.deepEqual(opened, []);
  // A public name that resolves to a private address.
  assert.deepEqual(await checkSite("https://careers.example.com/job/9", fetcher, async () => ["10.0.0.8"]), { by: "none" });
  assert.deepEqual(opened, []);
  // A public page that redirects onto the network: the redirect is not followed.
  assert.deepEqual(await checkSite("https://careers.example.com/job/9", fetcher, publicLookup), { by: "none" });
  assert.deepEqual(opened, ["https://careers.example.com/job/9"]);
});
