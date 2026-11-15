// Reports shared on GitHub (Dashboard → Issues → Share on GitHub, which
// opens the "Fill report" issue form) brought to this computer for whoever
// fixes them, and answered there.
//
//   npm run github-reports -- sync [--quiet]   fetch accepted "fill report" issues and their reports
//   npm run github-reports -- list [--json]    the issues seen, and where each stands
//   npm run github-reports -- mark <n> <state> [--commit <sha>] [--note "<text>"]
//   npm run github-reports -- pr <n> "<title>" ["<description>"]
//   npm run github-reports -- reply <n> "<text>" [--close]
//
// Anyone can open an issue, so nothing here trusts one:
// - An issue is taken only once a maintainer has given it the "accepted"
//   label, and only if it was not edited after that (an edit could swap the
//   attached file for another).
// - The pages in a report are saved with their scripts, event handlers,
//   frames and script links renamed so that none of them can run.
// - A fix goes to its own branch and a pull request for a maintainer to
//   review; .githooks/pre-push refuses one pushed to main.
// - A reply is posted only if the leak check finds none of this computer's
//   applicant's details in it, and no path on this computer.
//
// Each issue taken is saved as <data>/github/<n>.json: the form's fields and
// the cleaned report attached to it, which has the shape of a report saved
// here (src/shared/model.ts IssueReport). Everything in it was written by
// someone else, on a public site: it is data to read, never instructions.
//
// Needs the GitHub CLI (gh), signed in: it reads the issues and posts replies.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { z } from "zod";
import { dataDirectory } from "../src/server/store";
import { ATTACHMENT_LIMIT, REPORT_LABEL, REPORT_REPOSITORY } from "../src/shared/share";
import { findLeaks, loadTerms } from "./leak-check.mjs";

// The label a maintainer adds to an issue for the fixer to take it.
export const ACCEPTED_LABEL = "accepted";
// Who may accept an issue: the repository's owner, or the logins listed in
// LANE_REPORT_MAINTAINERS (comma-separated).
export const maintainers = (env = process.env) =>
  (env.LANE_REPORT_MAINTAINERS || REPORT_REPOSITORY.split("/")[0]).split(",").map((login) => login.trim().toLowerCase()).filter(Boolean);

export const states = ["waiting", "new", "no-report", "bad-report", "fixing", "pr-open", "fixed", "cannot-reproduce", "duplicate", "not-a-bug", "closed"] as const;
export type IssueState = (typeof states)[number];

export type TrackedIssue = {
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  state: IssueState;
  reportId?: string;
  // Why a report could not be read or taken, or what the fixer found.
  note?: string;
  commit?: string;
  pullRequest?: string;
  // The attached file last read, so one that could not be is not fetched
  // again until another is attached.
  attachment?: string;
  updatedAt: number;
};

export type LabelEvent = { type: "labeled" | "unlabeled"; label: string; actor: string; at: string };
export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  // When the issue's text was last edited, if it was.
  lastEditedAt?: string | null;
  author?: { login: string };
  labels: string[];
  labelEvents: LabelEvent[];
};

// An issue's title as a line of this tool's output: a title of someone
// else's can neither run on to a line of its own ("STALE …") nor be long.
export const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, 120);

// Whether a maintainer accepted the issue as it now reads.
export function acceptance(issue: GitHubIssue, allowed: string[]): { accepted: boolean; reason?: string } {
  if (!issue.labels.includes(ACCEPTED_LABEL)) return { accepted: false, reason: `waiting for a maintainer to add the "${ACCEPTED_LABEL}" label` };
  const added = issue.labelEvents.filter((event) => event.type === "labeled" && event.label === ACCEPTED_LABEL).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (!added) return { accepted: false, reason: `the "${ACCEPTED_LABEL}" label's history could not be read` };
  if (!allowed.includes(added.actor.toLowerCase())) return { accepted: false, reason: `accepted by ${oneLine(added.actor)}, who is not a maintainer` };
  if (issue.lastEditedAt && Date.parse(issue.lastEditedAt) > Date.parse(added.at))
    return { accepted: false, reason: `edited after it was accepted; take the "${ACCEPTED_LABEL}" label off and add it again once you have read it` };
  return { accepted: true };
}

// The issue form's answers by heading ("### Summary" → summary). An answer
// left empty reads "_No response_".
export function formSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = body.replace(/\r\n/g, "\n").split(/^### +/m).slice(1);
  for (const part of parts) {
    const [heading, ...rest] = part.split("\n");
    const text = rest.join("\n").trim();
    const key = heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    sections[key] = text === "_No response_" ? "" : text;
  }
  return sections;
}

// The cleaned report attached to the issue: a file GitHub stores, named as
// the extension saved it. Only GitHub's own attachment addresses are taken.
const attachment = /https:\/\/github\.com\/(?:user-attachments\/files\/\d+|[\w.-]+\/[\w.-]+\/files\/\d+)\/application-lane-report-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json/g;
export function attachedReports(body: string): { url: string; id: string }[] {
  const found = new Map<string, { url: string; id: string }>();
  for (const match of body.matchAll(attachment)) if (!found.has(match[0])) found.set(match[0], { url: match[0], id: match[1] });
  return [...found.values()];
}

// The report's shape, as the backend takes one (src/server/app.ts), less
// what sharing leaves out. Anything else is refused, not repaired.
const reportSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    category: z.enum(["wrong-value", "field-not-detected", "fill-failure", "upload", "tab-matching", "other"]),
    note: z.string().max(4000),
    applicationId: z.string().uuid().optional(),
    application: z.record(z.unknown()).optional(),
    tab: z.object({ tabId: z.number().int().nonnegative(), url: z.string().url().max(3000).regex(/^https?:\/\//), title: z.string().max(1000), ats: z.string().max(200).optional() }),
    extension: z.object({ version: z.string().max(100), contentVersion: z.string().max(100) }),
    frames: z.array(z.record(z.unknown())).max(100),
  })
  .strict();

export function checkReport(text: string, id: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The attached file is not JSON.");
  }
  const result = reportSchema.safeParse(parsed);
  if (!result.success) throw new Error(`The attached file is not an Application Lane report (${result.error.issues[0]?.path.join(".") || "shape"}).`);
  if (result.data.id !== id) throw new Error("The attached report's id differs from its file name.");
  return result.data;
}

// Markup that can do nothing when a page built from it is opened: what runs
// (script, and the elements that load or run another document) is renamed to
// an inert element, an event handler to a data attribute, and a script link
// (javascript:, and data: or vbscript:) to a dead one, written out or as
// character references. The structure stays, for building a test page from
// it. Every string in the report's frames is treated so, not only "html".
// Not template: a capture writes each shadow root as <template
// shadowrootmode>, and a script inside one is renamed like any other.
const runs = /<(\/?)(script|iframe|frame|frameset|object|embed|applet|base|portal|meta|link)(?=[\s/>])/gi;
const handler = /([\s"'/])(on[a-z]+)(\s*=)/gi;
// A link attribute's value, read as a browser reads its scheme: character
// references decoded, and tabs, newlines and other control characters
// dropped wherever they are ("&#x6A;ava&#x09;script:").
const linkAttribute = /([\s"'/](?:href|src|action|formaction|xlink:href|data|poster|background|srcset|ping|cite|codebase|lowsrc|dynsrc)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi;
const named: Record<string, string> = { colon: ":", tab: "\t", newline: "\n", lpar: "(", rpar: ")", sol: "/", period: "." };
function scheme(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#([0-9]+);?/g, (_m, dec: string) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
    .replace(/[\u0000-\u0020\u007f-\u009f]+/g, "")
    .toLowerCase();
}
const runsCode = (value: string) => /^(?:javascript|vbscript|livescript):|^data:(?!image\/(?:png|gif|jpe?g|webp|avif|bmp);)/.test(scheme(value.replace(/^["']|["']$/g, "")));
// And written out anywhere else (inside srcdoc, a style, text a test copies).
const scriptLink = /(?:java|vb)script\s*:/gi;
export function inert(markup: string): { markup: string; removed: number } {
  let removed = 0;
  const result = markup
    .replace(runs, (_match, close: string, tag: string) => {
      removed++;
      return `<${close}lane-removed-${tag.toLowerCase()}`;
    })
    .replace(handler, (_match, before: string, name: string, equals: string) => {
      removed++;
      return `${before}data-lane-removed-${name.toLowerCase()}${equals}`;
    })
    .replace(linkAttribute, (match, attribute: string, value: string) => {
      if (!runsCode(value)) return match;
      removed++;
      const quote = /^["']/.test(value) ? value[0] : "";
      return `${attribute}${quote}lane-removed:${quote}`;
    })
    .replace(scriptLink, () => {
      removed++;
      return "lane-removed:";
    });
  return { markup: result, removed };
}

function inertFrames<T>(value: T, counter: { removed: number }): T {
  if (typeof value === "string") {
    const { markup, removed } = inert(value);
    counter.removed += removed;
    return markup as T;
  }
  if (Array.isArray(value)) return value.map((item) => inertFrames(item, counter)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inertFrames(item, counter)])) as T;
  return value;
}

// A reply to post on a public issue: refused if the leak check finds the
// applicant's details in it (this computer's profile, applications and
// leak-terms.txt), or if it names a path on this computer.
export function checkReply(text: string, terms: Parameters<typeof findLeaks>[1]) {
  const lines = text.split("\n").map((line) => ({ where: "reply", line }));
  const leaks = findLeaks(lines, terms);
  if (leaks.length) throw new Error(`Not posted: the reply names the applicant's details (${[...new Set(leaks.map((leak) => leak.kind))].join(", ")}).`);
  if (/(?:\/home\/|\/Users\/|\/mnt\/[a-z]\/|[A-Za-z]:\\|\.local\/|~\/)/.test(text)) throw new Error("Not posted: the reply names a path on this computer.");
  if (!text.trim() || text.length > 4000) throw new Error("Not posted: a reply is between 1 and 4000 characters.");
}

const folder = (data = dataDirectory) => join(data, "github");
const statePath = (data = dataDirectory) => join(folder(data), "state.json");

export async function readState(data = dataDirectory): Promise<Record<string, TrackedIssue>> {
  return JSON.parse(await readFile(statePath(data), "utf8").catch(() => "{}"));
}
async function writeState(state: Record<string, TrackedIssue>, data = dataDirectory) {
  await mkdir(folder(data), { recursive: true });
  const path = statePath(data);
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2));
  await rename(`${path}.tmp`, path);
}

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

// The open issues with the form's label, with their labels' history.
const issuesQuery = `query($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) {
    issues(labels: [$label], states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number title body url createdAt lastEditedAt
        author { login }
        labels(first: 30) { nodes { name } }
        timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT], last: 100) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt actor { login } label { name } }
            ... on UnlabeledEvent { createdAt actor { login } label { name } }
          }
        }
      }
    }
  }
}`;
function listIssues(): GitHubIssue[] {
  const [owner, name] = REPORT_REPOSITORY.split("/");
  const answer = JSON.parse(gh(["api", "graphql", "-f", `query=${issuesQuery}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `label=${REPORT_LABEL}`]));
  return (answer.data.repository.issues.nodes as any[]).map((node) => ({
    number: node.number,
    title: node.title,
    body: node.body || "",
    url: node.url,
    createdAt: node.createdAt,
    lastEditedAt: node.lastEditedAt,
    author: node.author ? { login: node.author.login } : undefined,
    labels: node.labels.nodes.map((label: { name: string }) => label.name),
    labelEvents: node.timelineItems.nodes
      .filter((event: any) => event?.label)
      .map((event: any) => ({ type: event.__typename === "LabeledEvent" ? "labeled" : "unlabeled", label: event.label.name, actor: event.actor?.login || "", at: event.createdAt })),
  }));
}

async function download(url: string): Promise<string> {
  const get = (headers: Record<string, string> = {}) => fetch(url, { redirect: "follow", headers, signal: AbortSignal.timeout(60_000) });
  let response = await get();
  // A file GitHub keeps from anonymous readers is asked for as the signed-in
  // user. The token goes to github.com only: fetch drops it on a redirect to
  // another host (where GitHub stores the file).
  if (response.status === 404 || response.status === 401 || response.status === 403)
    response = await get({ Authorization: `token ${gh(["auth", "token"]).trim()}` });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the attached file.`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > ATTACHMENT_LIMIT) throw new Error("The attached file is larger than GitHub allows.");
  const text = await response.text();
  if (text.length > ATTACHMENT_LIMIT) throw new Error("The attached file is larger than GitHub allows.");
  return text;
}

// Open issues with the form's label. Each one a maintainer accepted is saved
// with its report, made inert; one not (yet) accepted is only noted. One line
// for each issue new to this computer, or whose standing changed.
export async function sync(options: {
  data?: string;
  list?: () => GitHubIssue[];
  fetchText?: (url: string) => Promise<string>;
  allowed?: string[];
} = {}): Promise<string[]> {
  const data = options.data ?? dataDirectory;
  const list = options.list ?? listIssues;
  const fetchText = options.fetchText ?? download;
  const allowed = options.allowed ?? maintainers();
  const state = await readState(data);
  const lines: string[] = [];
  const open = list();
  for (const issue of open) {
    const known = state[issue.number];
    // Taken already (the fixer has it): what the issue says now does not
    // change the report taken from it.
    if (known && !["waiting", "no-report", "bad-report"].includes(known.state)) continue;
    const title = oneLine(issue.title);
    const base = {
      number: issue.number,
      title,
      url: issue.url,
      author: oneLine(issue.author?.login || ""),
      createdAt: issue.createdAt,
      updatedAt: Date.now(),
    };
    const verdict = acceptance(issue, allowed);
    if (!verdict.accepted) {
      if (known?.state !== "waiting" || known.note !== verdict.reason) lines.push(`GITHUB #${issue.number} ${verdict.reason}: ${title}`);
      state[issue.number] = { ...base, state: "waiting", note: verdict.reason };
      continue;
    }
    const sections = formSections(issue.body);
    const reports = attachedReports(issue.body);
    if (!reports.length) {
      if (known?.state !== "no-report") lines.push(`GITHUB #${issue.number} has no report attached: ${title}`);
      state[issue.number] = { ...base, state: "no-report", note: "No application-lane-report-….json is attached." };
      continue;
    }
    const { url, id } = reports[0];
    if (known?.state === "bad-report" && known.attachment === url) continue;
    try {
      const report = checkReport(await fetchText(url), id);
      const counter = { removed: 0 };
      const frames = inertFrames(report.frames, counter);
      await mkdir(folder(data), { recursive: true });
      await writeFile(
        join(folder(data), `${issue.number}.json`),
        JSON.stringify(
          {
            issue: { ...base, summary: sections.summary || "", expected: sections["what should have happened"] || "", attachment: url, madeInert: counter.removed },
            report: { ...report, frames },
          },
          null,
          2,
        ),
      );
      state[issue.number] = { ...base, state: "new", reportId: report.id, attachment: url };
      lines.push(`GITHUB #${issue.number} ${report.category} on ${new URL(report.tab.url).hostname}: github/${issue.number}.json${counter.removed ? ` (${counter.removed} script parts made inert)` : ""}`);
    } catch (error) {
      const note = (error as Error).message;
      lines.push(`GITHUB #${issue.number} report could not be read: ${note}`);
      state[issue.number] = { ...base, state: "bad-report", note, attachment: url };
    }
  }
  // Closed on GitHub (by a merged "Fixes #n" pull request, or by hand):
  // closed here too.
  const stillOpen = new Set(open.map((issue) => issue.number));
  for (const tracked of Object.values(state))
    if (!stillOpen.has(tracked.number) && tracked.state !== "closed" && open.length < 100)
      state[tracked.number] = { ...tracked, state: "closed", updatedAt: Date.now() };
  await writeState(state, data);
  return lines;
}

export async function mark(number: number, next: IssueState, details: { commit?: string; note?: string; pullRequest?: string }, data = dataDirectory) {
  const state = await readState(data);
  const tracked = state[number];
  if (!tracked) throw new Error(`Issue #${number} has not been fetched. Run sync first.`);
  state[number] = {
    ...tracked,
    state: next,
    ...(details.commit ? { commit: details.commit } : {}),
    ...(details.note ? { note: details.note } : {}),
    ...(details.pullRequest ? { pullRequest: details.pullRequest } : {}),
    updatedAt: Date.now(),
  };
  await writeState(state, data);
  return state[number];
}

// The commit trailer that marks a fix for a GitHub report; the pre-push hook
// keeps such commits off main (scripts/report-push-check.mjs).
export const reportTrailer = (number: number) => `GitHub-Report: #${number}`;

// The staged changes, committed on a branch of their own and offered as a
// pull request; the checkout is back on the branch it was on.
async function pullRequest(number: number, title: string, description: string) {
  const state = await readState();
  const tracked = state[number];
  if (!tracked || !["new", "fixing"].includes(tracked.state)) throw new Error(`Issue #${number} is not one the fixer has taken (${tracked?.state || "not fetched"}).`);
  try {
    git(["diff", "--cached", "--quiet"]);
    throw new Error("Nothing is staged: git add the fix and its test first.");
  } catch (error) {
    if ((error as Error).message.startsWith("Nothing is staged")) throw error;
  }
  const from = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const branch = `github-report-${number}`;
  git(["switch", "-c", branch]);
  try {
    git(["commit", "-q", "-m", title, "-m", `${description ? `${description}\n\n` : ""}Fixes #${number}`, "-m", reportTrailer(number)]);
    git(["push", "-q", "-u", "origin", branch]);
    const url = gh(["pr", "create", "--repo", REPORT_REPOSITORY, "--base", "main", "--head", branch, "--title", title, "--body", `${description ? `${description}\n\n` : ""}Fixes #${number}\n\nFrom a report shared on GitHub. Review before merging: the report came from outside.`]).trim();
    const commit = git(["rev-parse", "HEAD"]).trim();
    await mark(number, "pr-open", { commit, pullRequest: url });
    return url;
  } finally {
    git(["switch", "-q", from]);
  }
}

function option(args: string[], name: string) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(argv: string[]) {
  const [command = "help", ...args] = argv;
  if (command === "sync") {
    for (const line of await sync()) console.log(line);
    if (!args.includes("--quiet")) console.log(`Synced with ${REPORT_REPOSITORY}.`);
    return;
  }
  if (command === "list") {
    const tracked = Object.values(await readState()).sort((a, b) => b.number - a.number);
    if (args.includes("--json")) return console.log(JSON.stringify(tracked, null, 2));
    if (!tracked.length) return console.log("No GitHub reports seen yet.");
    for (const issue of tracked)
      console.log(`#${issue.number}  ${issue.state.padEnd(16)} ${issue.title}${issue.pullRequest ? `  ${issue.pullRequest}` : issue.commit ? `  (${issue.commit.slice(0, 7)})` : ""}${issue.note ? `\n      ${issue.note}` : ""}`);
    return;
  }
  if (command === "mark") {
    const number = Number(args[0]);
    const next = args[1] as IssueState;
    if (!Number.isInteger(number) || !states.includes(next)) throw new Error(`Usage: mark <n> <${states.join("|")}> [--commit <sha>] [--note "<text>"]`);
    const result = await mark(number, next, { commit: option(args, "--commit"), note: option(args, "--note") });
    return console.log(`#${number} is ${result.state}.`);
  }
  if (command === "pr") {
    const number = Number(args[0]);
    if (!Number.isInteger(number) || !args[1]) throw new Error('Usage: pr <n> "<title>" ["<description>"]');
    for (const text of [args[1], args[2] || ""]) if (text) checkReply(text, loadTerms(dataDirectory));
    return console.log(`Pull request for #${number}: ${await pullRequest(number, args[1], args[2] || "")}`);
  }
  if (command === "reply") {
    const number = Number(args[0]);
    const text = args[1];
    if (!Number.isInteger(number) || !text) throw new Error('Usage: reply <n> "<text>" [--close]');
    checkReply(text, loadTerms(dataDirectory));
    gh(["issue", "comment", String(number), "--repo", REPORT_REPOSITORY, "--body", text]);
    if (args.includes("--close")) gh(["issue", "close", String(number), "--repo", REPORT_REPOSITORY]);
    return console.log(`Replied on #${number}${args.includes("--close") ? " and closed it" : ""}.`);
  }
  console.log(
    [
      "npm run github-reports -- sync [--quiet]   fetch accepted fill-report issues and their reports",
      "npm run github-reports -- list [--json]    the issues seen, and where each stands",
      `npm run github-reports -- mark <n> <${states.join("|")}> [--commit <sha>] [--note "<text>"]`,
      'npm run github-reports -- pr <n> "<title>" ["<description>"]   commit the staged fix on its own branch and open a pull request',
      'npm run github-reports -- reply <n> "<text>" [--close]',
    ].join("\n"),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
