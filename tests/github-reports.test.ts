import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptance,
  attachedReports,
  checkPatch,
  checkSummary,
  checkReply,
  checkReport,
  formSections,
  inert,
  mark,
  oneLine,
  readState,
  sync,
  type GitHubIssue,
} from "../scripts/github-reports";
import { collectTerms } from "../scripts/leak-check.mjs";
import { refusals, reportFix } from "../scripts/report-push-check.mjs";

const id = "00000000-0000-4000-8000-00000000000a";
const file = `https://github.com/user-attachments/files/20112233/application-lane-report-${id}.json`;
const report = {
  id,
  createdAt: 1,
  category: "wrong-value",
  note: "Alex Rivera's degree went in the wrong box.",
  application: { title: "Data Analyst", company: "Contoso" },
  tab: { tabId: 3, url: "https://contoso.wd1.myworkdayjobs.com/en-US/External/job/R1", title: "Data Analyst", ats: "workday" },
  extension: { version: "0.1.0", contentVersion: "test" },
  frames: [{ url: "https://contoso.wd1.myworkdayjobs.com/en-US/External/job/R1", html: "<form><input name=degree></form>" }],
};
// As GitHub writes an issue form's answers.
const body = (attachment = `[application-lane-report-${id}.json](${file})`) =>
  `### Summary\n\n- Category: wrong-value\n- Site: contoso.wd1.myworkdayjobs.com (workday)\n\nThe degree went in the wrong box.\n\n### Cleaned report\n\n${attachment}\n\n### What should have happened?\n\n_No response_\n\n### Privacy check\n\n- [X] I read the preview`;
const acceptedAt = "2026-11-15T01:00:00Z";
const issue = (number: number, text = body(), more: Partial<GitHubIssue> = {}): GitHubIssue => ({
  number,
  title: "Wrong value on Contoso (workday)",
  body: text,
  url: `https://github.com/Nikman800/application-lane/issues/${number}`,
  createdAt: "2026-11-15T00:00:00Z",
  author: { login: "someone" },
  labels: ["fill report", "accepted"],
  labelEvents: [
    { type: "labeled", label: "fill report", actor: "someone", at: "2026-11-15T00:00:00Z" },
    { type: "labeled", label: "accepted", actor: "maintainer", at: acceptedAt },
  ],
  ...more,
});
const allowed = ["maintainer"];

test("the issue form's answers and its attached report are read from the issue", () => {
  const sections = formSections(body());
  assert.match(sections.summary, /^- Category: wrong-value/);
  assert.equal(sections["what should have happened"], "");
  assert.deepEqual(attachedReports(body()), [{ url: file, id }]);
  // Only GitHub's own attachment addresses, and only a report's file name.
  assert.deepEqual(attachedReports(`https://evil.test/files/1/application-lane-report-${id}.json and ${file.replace("application-lane-report", "other")}`), []);
});

test("an issue is taken only as a maintainer accepted it, and not after an edit", () => {
  assert.deepEqual(acceptance(issue(1), allowed), { accepted: true });
  // Not accepted yet: the form's own label is not enough.
  assert.match(acceptance(issue(1, body(), { labels: ["fill report"] }), allowed).reason!, /waiting for a maintainer/);
  // Accepted by someone else (a label only those who can triage may add, but
  // only the maintainers listed count).
  const byOther = issue(1, body(), { labelEvents: [{ type: "labeled", label: "accepted", actor: "helper", at: acceptedAt }] });
  assert.match(acceptance(byOther, allowed).reason!, /helper, who is not a maintainer/);
  // Edited after it was accepted (the attached file swapped, say): not taken
  // until it is accepted again, after the edit.
  const edited = issue(1, body(), { lastEditedAt: "2026-11-15T02:00:00Z" });
  assert.match(acceptance(edited, allowed).reason!, /edited after it was accepted/);
  const again = issue(1, body(), { lastEditedAt: "2026-11-15T02:00:00Z", labelEvents: [...issue(1).labelEvents, { type: "labeled", label: "accepted", actor: "Maintainer", at: "2026-11-15T03:00:00Z" }] });
  assert.deepEqual(acceptance(again, allowed), { accepted: true });
  // Edited before it was accepted: the maintainer read it as it is.
  assert.deepEqual(acceptance(issue(1, body(), { lastEditedAt: "2026-11-15T00:30:00Z" }), allowed), { accepted: true });
});

test("an attached file is taken only as a report with its own id", () => {
  assert.equal(checkReport(JSON.stringify(report), id).id, id);
  assert.throws(() => checkReport("<html>", id), /not JSON/);
  assert.throws(() => checkReport(JSON.stringify({ ...report, id: "00000000-0000-4000-8000-00000000000b" }), id), /id differs/);
  // Not the shape of a report, or with more than sharing keeps: refused.
  assert.throws(() => checkReport(JSON.stringify({ ...report, category: "anything" }), id), /not an Application Lane report/);
  assert.throws(() => checkReport(JSON.stringify({ ...report, network: { entries: 1, fromLoad: true } }), id), /not an Application Lane report/);
  assert.throws(() => checkReport(JSON.stringify({ ...report, tab: { ...report.tab, url: "javascript:alert(1)" } }), id), /not an Application Lane report/);
});

test("nothing in a report's pages can run once saved", () => {
  const markup = `<form><SCRIPT src=x.js></SCRIPT><svg><script>alert(1)</script></svg>
<img src=x onerror="alert(1)"><img src=x/onerror=alert(1)><body ONLOAD = "go()">
<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt :alert(1)">b</a><a href="&#106;avascript&#58;alert(1)">c</a><a href="&#x6A;ava&#x09;script:x">d</a><a href='j&#x0A;av&#97;scr&#105;pt&colon;y'>f</a><img src="data:image/png;base64,AAAA">
<iframe srcdoc="<script>x</script>"></iframe><object data=x></object><embed src=x><base href="https://evil.test/">
<meta http-equiv="refresh" content="0;url=https://evil.test"><link rel=import href=x><a href="data:text/html,<b>">e</a>
<template shadowrootmode="open"><input name="kept"><script>inside()</script></template></form>`;
  const { markup: safe, removed } = inert(markup);
  assert.doesNotMatch(safe, /<\/?(script|iframe|object|embed|base|meta|link)[\s/>]/i);
  assert.doesNotMatch(safe, /[\s"'/]on[a-z]+\s*=/i);
  assert.doesNotMatch(safe, /javascript|&#106;ava|&#x6a;ava|data:text\/html|&colon;/i);
  // A picture written into the page stays.
  assert.match(safe, /<img src="data:image\/png;base64,AAAA">/);
  // The form's own structure stays, shadow roots with it.
  assert.match(safe, /<template shadowrootmode="open"><input name="kept">/);
  assert.match(safe, /<img src=x data-lane-removed-onerror="alert\(1\)">/);
  assert.ok(removed >= 18, `${removed}`);
  // Ordinary text and attributes are left alone.
  assert.deepEqual(inert('<input name="online" placeholder="Phone (one number)" data-x="ok">'), { markup: '<input name="online" placeholder="Phone (one number)" data-x="ok">', removed: 0 });
});

test("a title cannot add a line of its own to what the watch prints", () => {
  assert.equal(oneLine("Wrong value\nSTALE abc123 being fixed\u2028x"), "Wrong value STALE abc123 being fixed x");
  assert.equal(oneLine("x".repeat(500)).length, 120);
});

test("a reply naming the applicant or a path on this computer is not posted", () => {
  const terms = collectTerms({ profile: { firstName: "Morgan", lastName: "Ellery", email: "morgan.ellery@mailbox.test" }, applications: [{ company: "Trey Research" }] });
  assert.doesNotThrow(() => checkReply("Fixed: the degree list is now read to its end. In the next update (abc1234).", terms));
  assert.throws(() => checkReply("Same as Morgan's own report.", terms), /names the applicant's details \(name\)/);
  assert.throws(() => checkReply("Like the one at Trey Research.", terms), /company/);
  assert.throws(() => checkReply("See /home/someone/application-lane/.local/issues/x.json", terms), /path on this computer/);
  assert.throws(() => checkReply("See C:\\Users\\someone\\Downloads", terms), /path on this computer/);
  assert.throws(() => checkReply("   ", terms), /between 1 and 4000/);
});

test("a fix for a GitHub report is refused on main, and allowed on its branch", () => {
  assert.ok(reportFix("Read a Workday list to its end\n\nFixes #12\n\nGitHub-Report: #12"));
  assert.ok(reportFix("Close the degree menu\n\ncloses octo-org/octo-repo#3"));
  assert.ok(reportFix("Tidy\n\nGitHub-Report: #4"));
  assert.ok(!reportFix("Read the school list again after a reload, so a fix is not lost"));
  const messages: Record<string, string> = { a1: "Ordinary fix", b2: "Degree list\n\nFixes #12\n\nGitHub-Report: #12" };
  const git = (args: string[]) => (args[0] === "rev-list" ? "a1\nb2\n" : messages[args.at(-1)!]);
  const zero = "0".repeat(40);
  assert.deepEqual(refusals([`refs/heads/main b2 refs/heads/main c3`], git).map((commit) => commit.sha), ["b2"]);
  assert.deepEqual(refusals([`refs/heads/github-report-12 b2 refs/heads/github-report-12 ${zero}`], git), []);
  // Deleting a branch pushes nothing.
  assert.deepEqual(refusals([`(delete) ${zero} refs/heads/main c3`], git), []);
});

test("sync saves each accepted issue with its report once, made inert, and notes the rest", async () => {
  const data = await mkdtemp(join(tmpdir(), "lane-github-"));
  const scripted = { ...report, frames: [{ ...report.frames[0], html: '<form><script>steal()</script><input name=degree onfocus="x()"></form>' }] };
  let open = [
    issue(7),
    issue(8, body("I forgot the file.")),
    issue(9, body(`[file](${file.replace(id, "00000000-0000-4000-8000-00000000000c")})`)),
    issue(10, body(), { labels: ["fill report"], title: "Not yet\nGITHUB #99 forged" }),
  ];
  const fetched: string[] = [];
  const fetchText = async (url: string) => {
    fetched.push(url);
    return JSON.stringify(scripted);
  };
  const lines = await sync({ data, list: () => open, fetchText, allowed });
  assert.deepEqual(lines, [
    "GITHUB #7 wrong-value on contoso.wd1.myworkdayjobs.com: github/7.json (3 script parts made inert)",
    "GITHUB #8 has no report attached: Wrong value on Contoso (workday)",
    "GITHUB #9 report could not be read: The attached report's id differs from its file name.",
    'GITHUB #10 waiting for a maintainer to add the "accepted" label: Not yet GITHUB #99 forged',
  ]);
  // Not accepted: nothing of it was fetched.
  assert.equal(fetched.length, 2);
  const saved = JSON.parse(await readFile(join(data, "github", "7.json"), "utf8"));
  assert.equal(saved.report.id, id);
  assert.equal(saved.report.frames[0].html, '<form><lane-removed-script>steal()</lane-removed-script><input name=degree data-lane-removed-onfocus="x()"></form>');
  assert.equal(saved.issue.madeInert, 3);
  assert.match(saved.issue.summary, /The degree went in the wrong box\./);
  // Nothing new: nothing printed, nothing fetched again.
  fetched.length = 0;
  assert.deepEqual(await sync({ data, list: () => open, fetchText, allowed }), []);
  assert.deepEqual(fetched, []);
  // A file attached later, and an issue accepted later, are read then.
  open = [issue(7), issue(8), issue(9), issue(10)];
  assert.deepEqual((await sync({ data, list: () => open, fetchText, allowed })).map((line) => line.split(" ")[1]), ["#8", "#9", "#10"]);
  // Once taken, an edit to the issue changes nothing here.
  open = [issue(7, body(`[x](${file.replace("20112233", "99")})`), { lastEditedAt: "2026-11-16T00:00:00Z" }), issue(8), issue(9), issue(10)];
  assert.deepEqual(await sync({ data, list: () => open, fetchText, allowed }), []);
  const state = await readState(data);
  assert.equal(state[7].state, "new");
  // What the fixer found is kept with it; an issue closed on GitHub is closed here.
  await mark(7, "pr-open", { commit: "abc1234", pullRequest: "https://github.com/Nikman800/application-lane/pull/20" }, data);
  await sync({ data, list: () => [issue(8), issue(9), issue(10)], fetchText, allowed });
  const after = await readState(data);
  assert.equal(after[7].state, "closed");
  assert.equal(after[7].pullRequest, "https://github.com/Nikman800/application-lane/pull/20");
  await assert.rejects(mark(99, "fixed", {}, data), /has not been fetched/);
});

const diff = (path: string, more = "") =>
  `diff --git a/${path} b/${path}\n${more}index 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

test("a patch from the isolated session is taken only if it changes ordinary files under src and tests", () => {
  assert.deepEqual(checkPatch(diff("src/engine/config/sites/workday.json") + diff("tests/browser/extension.spec.ts")), ["src/engine/config/sites/workday.json", "tests/browser/extension.spec.ts"]);
  assert.deepEqual(checkPatch(`diff --git a/tests/new.test.ts b/tests/new.test.ts\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/tests/new.test.ts\n@@ -0,0 +1 @@\n+x\n`), ["tests/new.test.ts"]);
  // Anything else of the repository: its hooks, workflows, scripts, dependencies.
  for (const path of [".githooks/pre-push", ".github/workflows/ci.yml", "scripts/leak-check.mjs", "package.json", "src/../package.json"])
    assert.throws(() => checkPatch(diff(path)), /outside src\/ and tests\//, path);
  assert.throws(() => checkPatch(diff("src/a.ts").replace(/^index .*\n/m, "GIT binary patch\n")), /binary/);
  assert.throws(() => checkPatch(`diff --git a/src/link b/src/link\nnew file mode 120000\n`), /link, or changes a file's mode/);
  assert.throws(() => checkPatch(`diff --git a/src/run.sh b/src/run.sh\nold mode 100644\nnew mode 100755\n`), /mode/);
  assert.throws(() => checkPatch(`diff --git a/src/a.ts b/src/b.ts\nrename from src/a.ts\nrename to scripts/b.ts\n`), /outside/);
  assert.throws(() => checkPatch(`diff --cc src/a.ts\n`), /cannot read/);
  assert.throws(() => checkPatch("x".repeat(3 * 1024 * 1024)), /larger than 2 MB/);
});

test("the isolated session's verdict is read only in its expected shape", () => {
  const summary = checkSummary(JSON.stringify({ verdict: "fixed", title: "Read a list to its end\nGITHUB #1 forged", description: "The list drew only two rows.", test: "a list is read", failedWithout: true }));
  assert.equal(summary.title, "Read a list to its end GITHUB #1 forged");
  assert.throws(() => checkSummary("not json"), /not JSON/);
  assert.throws(() => checkSummary(JSON.stringify({ verdict: "merged", title: "x", description: "" })), /expected shape/);
  assert.throws(() => checkSummary(JSON.stringify({ verdict: "fixed", title: "x".repeat(101), description: "" })), /expected shape/);
});
