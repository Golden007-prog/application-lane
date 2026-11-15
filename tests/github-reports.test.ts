import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedReports, checkReport, formSections, mark, readState, sync, type GitHubIssue } from "../scripts/github-reports";

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
  frames: [{ url: "https://contoso.wd1.myworkdayjobs.com/en-US/External/job/R1", html: "<form></form>" }],
};
// As GitHub writes an issue form's answers.
const body = (attachment = `[application-lane-report-${id}.json](${file})`) =>
  `### Summary\n\n- Category: wrong-value\n- Site: contoso.wd1.myworkdayjobs.com (workday)\n\nThe degree went in the wrong box.\n\n### Cleaned report\n\n${attachment}\n\n### What should have happened?\n\n_No response_\n\n### Privacy check\n\n- [X] I read the preview`;
const issue = (number: number, text = body()): GitHubIssue => ({
  number,
  title: "Wrong value on Contoso (workday)",
  body: text,
  url: `https://github.com/Nikman800/application-lane/issues/${number}`,
  createdAt: "2026-11-15T00:00:00Z",
  author: { login: "someone" },
});

test("the issue form's answers and its attached report are read from the issue", () => {
  const sections = formSections(body());
  assert.match(sections.summary, /^- Category: wrong-value/);
  assert.equal(sections["what should have happened"], "");
  assert.deepEqual(attachedReports(body()), [{ url: file, id }]);
  // Only GitHub's own attachment addresses, and only a report's file name.
  assert.deepEqual(attachedReports(`https://evil.test/files/1/application-lane-report-${id}.json and ${file.replace("application-lane-report", "other")}`), []);
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

test("sync saves each new issue with its report once, and records those it cannot read", async () => {
  const data = await mkdtemp(join(tmpdir(), "lane-github-"));
  let open = [issue(7), issue(8, body("I forgot the file.")), issue(9, body(`[file](${file.replace(id, "00000000-0000-4000-8000-00000000000c")})`))];
  const fetched: string[] = [];
  const fetchText = async (url: string) => {
    fetched.push(url);
    return JSON.stringify(report);
  };
  const lines = await sync({ data, list: () => open, fetchText });
  assert.deepEqual(lines, [
    "GITHUB #7 wrong-value on contoso.wd1.myworkdayjobs.com: github/7.json",
    "GITHUB #8 has no report attached: Wrong value on Contoso (workday)",
    "GITHUB #9 report could not be read: The attached report's id differs from its file name.",
  ]);
  const saved = JSON.parse(await readFile(join(data, "github", "7.json"), "utf8"));
  assert.equal(saved.report.id, id);
  assert.match(saved.issue.summary, /The degree went in the wrong box\./);
  assert.equal(saved.issue.author, "someone");
  // Nothing new: nothing printed, nothing fetched again.
  fetched.length = 0;
  assert.deepEqual(await sync({ data, list: () => open, fetchText }), []);
  assert.deepEqual(fetched, []);
  // The file attached later is read then.
  open = [issue(7), issue(8), issue(9)];
  assert.deepEqual((await sync({ data, list: () => open, fetchText })).map((line) => line.split(" ")[1]), ["#8", "#9"]);
  const state = await readState(data);
  assert.equal(state[8].state, "new");
  // What the fixer found is kept with it; an issue closed on GitHub is closed here.
  await mark(7, "fixed", { commit: "abc1234", note: "Degree matched by its listed wording." }, data);
  await sync({ data, list: () => [issue(8), issue(9)], fetchText });
  const after = await readState(data);
  assert.equal(after[7].state, "closed");
  assert.equal(after[7].commit, "abc1234");
  await assert.rejects(mark(99, "fixed", {}, data), /has not been fetched/);
});
