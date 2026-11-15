import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { configSchema } from "../src/server/store";
import { createApp } from "../src/server/app";
import { issueSummary, issueTitle, newIssueLink, REPORT_REPOSITORY, type SharedReport } from "../src/shared/share";

// A made-up applicant, as in clean-report.test.ts.
const config = () => configSchema.parse({ postingLookup: false, token: "test-token-".repeat(7), model: "test", endpoint: "http://127.0.0.1:9999/v1" });

test("a saved report is given back cleaned for sharing, and nothing is saved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lane-share-"));
  const cfg = config();
  const { server, store } = await createApp(cfg, directory);
  Object.assign(store.data.profile, { firstName: "Morgan", lastName: "Ellery", email: "morgan.ellery@mailbox.test", city: "Prescott", work: [{ organization: "Harborview Analytics" }] });
  await writeFile(join(directory, "queue.json"), JSON.stringify({ at: 1, applications: [
    { company: "Fourth Coffee", url: "https://fourthcoffee.wd5.myworkdayjobs.com/en-US/External/job/R100" },
    { company: "Trey Research", url: "https://treyresearch.wd1.myworkdayjobs.com/careers/job/R200" },
  ] }));
  await writeFile(join(directory, "submissions.json"), JSON.stringify([{ company: "Wide World Importers", url: "https://jobs.lever.co/wideworld/1" }]));
  await writeFile(join(directory, "leak-terms.txt"), "# a nickname\nMoe Ellery\n");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  const id = randomUUID();
  const report = {
    id,
    createdAt: Date.UTC(2026, 10, 15),
    category: "wrong-value",
    note: "Morgan's city Prescott went in the wrong box; Trey Research and Wide World Importers were fine. Moe Ellery.",
    application: { title: "Data Analyst", company: "Fourth Coffee", workflowStage: "applying", status: "awaiting-user", operation: 1, missing: [], attempts: [] },
    tab: { tabId: 4, url: "https://fourthcoffee.wd5.myworkdayjobs.com/en-US/External/job/R100", title: "Data Analyst - Fourth Coffee", ats: "workday" },
    extension: { version: "0.1.0", contentVersion: "test" },
    network: { entries: 1, fromLoad: true },
    har: { log: { version: "1.2", entries: [{ request: { url: "https://fourthcoffee.wd5.myworkdayjobs.com/" } }] } },
    frames: [{ url: "https://fourthcoffee.wd5.myworkdayjobs.com/en-US/External/job/R100", html: "<h2>Morgan Ellery</h2><input data-lane-value=\"morgan.ellery@mailbox.test\"><p>Harborview Analytics</p>" }],
  };
  try {
    assert.equal((await fetch(`${url}/v1/issues`, { method: "POST", headers, body: JSON.stringify(report) })).status, 201);
    const response = await fetch(`${url}/v1/issues/${id}/share`, { headers });
    assert.equal(response.status, 200);
    const shared = (await response.json()) as SharedReport;
    const text = JSON.stringify(shared.report);
    for (const detail of ["Morgan", "Ellery", "mailbox.test", "Prescott", "Harborview", "Trey Research", "Wide World", "Moe"])
      assert.ok(!text.includes(detail), `${detail} was shared`);
    // The report's own company and site stay, so it can be reproduced.
    assert.ok(text.includes("Fourth Coffee") && text.includes("fourthcoffee.wd5.myworkdayjobs.com"));
    assert.ok(shared.replaced.name > 0);
    assert.deepEqual(shared.removed, ["the page's network log"]);
    assert.equal((shared.report as any).network, undefined);
    // The saved report itself is left as it was.
    const saved = await (await fetch(`${url}/v1/issues/${id}`, { headers })).json();
    assert.equal(saved.note, report.note);
    assert.equal((await fetch(`${url}/v1/issues/${randomUUID()}/share`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/v1/issues/${id}/share`)).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const shared = (note: string): SharedReport => ({
  report: {
    id: "00000000-0000-4000-8000-000000000009",
    createdAt: Date.UTC(2026, 10, 15),
    category: "field-not-detected",
    note,
    application: { title: "Data Analyst", company: "Fourth Coffee", workflowStage: "applying", status: "awaiting-user", operation: 1, missing: [], attempts: [] },
    tab: { tabId: 4, url: "https://fourthcoffee.wd5.myworkdayjobs.com/en-US/External/job/R100", title: "Data Analyst", ats: "workday" },
    extension: { version: "0.1.0", contentVersion: "abc123" },
    frames: [],
  },
  replaced: { email: 2, name: 5 },
  removed: ["the recording of the fill"],
});

test("the issue form opens filled in from the cleaned report, within a link's length", () => {
  const short = shared("The degree box stayed empty.");
  assert.equal(issueTitle(short), "Field not detected on Fourth Coffee (workday)");
  const summary = issueSummary(short);
  assert.match(summary, /- Site: fourthcoffee\.wd5\.myworkdayjobs\.com \(workday\)/);
  assert.match(summary, /- Cleaned before sharing: name \(5\), email \(2\)/);
  assert.match(summary, /- Left out: the recording of the fill/);
  assert.match(summary, /The degree box stayed empty\.$/);
  const link = new URL(newIssueLink(short));
  assert.equal(`${link.origin}${link.pathname}`, `https://github.com/${REPORT_REPOSITORY}/issues/new`);
  assert.equal(link.searchParams.get("template"), "fill-report.yml");
  assert.equal(link.searchParams.get("summary"), summary);
  // A long note (in characters that take nine in a link) is cut; the facts
  // above it are kept, and the attached file holds the note whole.
  const long = newIssueLink(shared("é ✓ ".repeat(5_000)));
  assert.ok(long.length <= 7_500, `${long.length}`);
  const cut = new URL(long).searchParams.get("summary")!;
  assert.match(cut, /- Cleaned before sharing:/);
  assert.match(cut, /The note continues in the attached report\.\)$/);
});
