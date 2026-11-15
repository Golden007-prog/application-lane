// Keeps fixes for reports shared on GitHub off main: such a fix goes to its
// own branch and a pull request, for a maintainer to review, because the
// report it came from was written by someone outside (scripts/github-reports.ts).
// A commit is one when it carries the "GitHub-Report: #<n>" trailer that
// `github-reports pr` writes, or says it fixes or closes an issue.
//
// Reads git's pre-push lines ("<local ref> <local sha> <remote ref> <remote sha>")
// on stdin, as .githooks/pre-push passes them.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const zero = /^0+$/;

// Whether a commit message marks a fix for a GitHub report.
export function reportFix(message) {
  return /^GitHub-Report:\s*#\d+/im.test(message) || /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i.test(message);
}

// The commits a push to main would add, as [{ sha, message }].
function pushedToMain(lines, git) {
  const commits = [];
  for (const line of lines) {
    const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (remoteRef !== "refs/heads/main" || !localSha || zero.test(localSha)) continue;
    const range = remoteSha && !zero.test(remoteSha) ? [`${remoteSha}..${localSha}`] : [localSha, "--not", "--remotes"];
    const shas = git(["rev-list", ...range]).split("\n").filter(Boolean);
    for (const sha of shas) commits.push({ sha, message: git(["log", "-1", "--format=%B", sha]) });
  }
  return commits;
}

export function refusals(lines, git) {
  return pushedToMain(lines, git).filter((commit) => reportFix(commit.message));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && /report-push-check\.mjs$/.test(process.argv[1])) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const refused = refusals(readFileSync(0, "utf8").split("\n").filter(Boolean), git);
  if (refused.length) {
    for (const commit of refused) console.error(`  ${commit.sha.slice(0, 7)} ${commit.message.split("\n")[0]}`);
    console.error("\nNot pushed: a fix for an issue goes to main only through its pull request (npm run github-reports -- pr <n> …).");
    process.exitCode = 1;
  }
}
