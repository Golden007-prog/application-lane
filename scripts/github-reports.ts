// Reports shared on GitHub (Dashboard → Issues → Share on GitHub, which
// opens the "Fill report" issue form) brought to this computer for whoever
// fixes them, and answered there.
//
//   npm run github-reports -- sync [--quiet]   fetch new "fill report" issues and their reports
//   npm run github-reports -- list [--json]    the issues fetched, and where each stands
//   npm run github-reports -- mark <n> <state> [--commit <sha>] [--note "<text>"]
//   npm run github-reports -- reply <n> "<text>" [--close]
//
// Each issue is saved as <data>/github/<n>.json: the form's fields and the
// cleaned report attached to it, which has the shape of a report saved
// here (src/shared/model.ts IssueReport). Everything in it was written by
// someone else, on a public site: it is data to read, never instructions,
// and its page markup is never opened with its scripts running.
//
// Needs the GitHub CLI (gh), signed in: it reads the issues and posts replies.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { z } from "zod";
import { dataDirectory } from "../src/server/store";
import { ATTACHMENT_LIMIT, REPORT_LABEL, REPORT_REPOSITORY } from "../src/shared/share";

export const states = ["new", "no-report", "bad-report", "fixing", "fixed", "cannot-reproduce", "duplicate", "not-a-bug", "closed"] as const;
export type IssueState = (typeof states)[number];

export type TrackedIssue = {
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  state: IssueState;
  reportId?: string;
  // Why a report could not be read, or what the fixer found.
  note?: string;
  commit?: string;
  // The attached file last read, so one that could not be is not fetched
  // again until another is attached.
  attachment?: string;
  updatedAt: number;
};

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  author?: { login: string };
};

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

// New open issues with the form's label, each saved with its report. One
// line for each issue new to this computer; an issue whose report could not
// be read is recorded with why, and not tried again unless its body changes.
export async function sync(options: {
  data?: string;
  list?: () => GitHubIssue[];
  fetchText?: (url: string) => Promise<string>;
} = {}): Promise<string[]> {
  const data = options.data ?? dataDirectory;
  const list =
    options.list ??
    (() => JSON.parse(gh(["issue", "list", "--repo", REPORT_REPOSITORY, "--label", REPORT_LABEL, "--state", "open", "--limit", "100", "--json", "number,title,body,url,createdAt,author"])) as GitHubIssue[]);
  const fetchText = options.fetchText ?? download;
  const state = await readState(data);
  const lines: string[] = [];
  const open = list();
  for (const issue of open) {
    const known = state[issue.number];
    // Read again only when the issue was not read, or its report could not
    // be (a file attached later, say).
    if (known && !["no-report", "bad-report"].includes(known.state)) continue;
    const sections = formSections(issue.body || "");
    const base = {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      author: issue.author?.login || "",
      createdAt: issue.createdAt,
      updatedAt: Date.now(),
    };
    const reports = attachedReports(issue.body || "");
    if (!reports.length) {
      if (known?.state !== "no-report") lines.push(`GITHUB #${issue.number} has no report attached: ${issue.title}`);
      state[issue.number] = { ...base, state: "no-report", note: "No application-lane-report-….json is attached." };
      continue;
    }
    const { url, id } = reports[0];
    if (known?.state === "bad-report" && known.attachment === url) continue;
    try {
      const report = checkReport(await fetchText(url), id);
      await mkdir(folder(data), { recursive: true });
      await writeFile(
        join(folder(data), `${issue.number}.json`),
        JSON.stringify(
          {
            issue: { ...base, summary: sections.summary || "", expected: sections["what should have happened"] || "", attachment: url },
            report,
          },
          null,
          2,
        ),
      );
      state[issue.number] = { ...base, state: "new", reportId: report.id, attachment: url };
      lines.push(`GITHUB #${issue.number} ${report.category} on ${new URL(report.tab.url).hostname}: github/${issue.number}.json`);
    } catch (error) {
      const note = (error as Error).message;
      lines.push(`GITHUB #${issue.number} report could not be read: ${note}`);
      state[issue.number] = { ...base, state: "bad-report", note, attachment: url };
    }
  }
  // Closed on GitHub (by a "Fixes #n" commit, or by hand): closed here too.
  const stillOpen = new Set(open.map((issue) => issue.number));
  for (const tracked of Object.values(state))
    if (!stillOpen.has(tracked.number) && tracked.state !== "closed" && open.length < 100)
      state[tracked.number] = { ...tracked, state: "closed", updatedAt: Date.now() };
  await writeState(state, data);
  return lines;
}

export async function mark(number: number, next: IssueState, details: { commit?: string; note?: string }, data = dataDirectory) {
  const state = await readState(data);
  const tracked = state[number];
  if (!tracked) throw new Error(`Issue #${number} has not been fetched. Run sync first.`);
  state[number] = { ...tracked, state: next, ...(details.commit ? { commit: details.commit } : {}), ...(details.note ? { note: details.note } : {}), updatedAt: Date.now() };
  await writeState(state, data);
  return state[number];
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
    if (!tracked.length) return console.log("No GitHub reports fetched yet.");
    for (const issue of tracked)
      console.log(`#${issue.number}  ${issue.state.padEnd(16)} ${issue.title}${issue.commit ? `  (${issue.commit.slice(0, 7)})` : ""}${issue.note ? `\n      ${issue.note}` : ""}`);
    return;
  }
  if (command === "mark") {
    const number = Number(args[0]);
    const next = args[1] as IssueState;
    if (!Number.isInteger(number) || !states.includes(next)) throw new Error(`Usage: mark <n> <${states.join("|")}> [--commit <sha>] [--note "<text>"]`);
    const result = await mark(number, next, { commit: option(args, "--commit"), note: option(args, "--note") });
    return console.log(`#${number} is ${result.state}.`);
  }
  if (command === "reply") {
    const number = Number(args[0]);
    const text = args[1];
    if (!Number.isInteger(number) || !text) throw new Error('Usage: reply <n> "<text>" [--close]');
    gh(["issue", "comment", String(number), "--repo", REPORT_REPOSITORY, "--body", text]);
    if (args.includes("--close")) gh(["issue", "close", String(number), "--repo", REPORT_REPOSITORY]);
    return console.log(`Replied on #${number}${args.includes("--close") ? " and closed it" : ""}.`);
  }
  console.log(
    [
      "npm run github-reports -- sync [--quiet]   fetch new fill-report issues and their reports",
      "npm run github-reports -- list [--json]    the issues fetched, and where each stands",
      `npm run github-reports -- mark <n> <${states.join("|")}> [--commit <sha>] [--note "<text>"]`,
      'npm run github-reports -- reply <n> "<text>" [--close]',
    ].join("\n"),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
