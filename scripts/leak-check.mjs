// Keeps the applicant's own details out of what is committed and pushed.
//
//   node scripts/leak-check.mjs --staged          what `git commit` would record (pre-commit)
//   node scripts/leak-check.mjs --message <file>  a commit message (commit-msg)
//   node scripts/leak-check.mjs --push            what `git push` would send (pre-push; reads its stdin)
//   node scripts/leak-check.mjs --range <a>..<b>  the commits in a range: changes, messages, authors
//   node scripts/leak-check.mjs --all [<dir>]     every tracked file (an audit, or an export's folder)
//   node scripts/leak-check.mjs --terms           which terms it would look for (on this machine only)
//
// The terms come from the applicant's data folder, never from the repository:
// the saved profile (names, email, phone, address, schools, employers,
// references, profile links), the companies and job-site addresses of the
// applications in the queue, and two optional files there:
//   leak-terms.txt   more terms, one per line (a former employer, a nickname)
//   leak-allow.txt   terms that are fine to commit, one per line (a job-site
//                    vendor that is also a company you applied to)
// The data folder is found as the backend finds it: --data-dir, LANE_DATA_DIR,
// a .local/ with a config.json here or beside this script, or the platform's
// app-data folder. With no data there (another contributor, CI) nothing is
// checked and it says so.
//
// Exit 1 when anything matched, naming file:line and what kind of detail it is.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTerms, findLeaks, matcher } from "../src/server/leak-terms.mjs";
// The terms and how they are matched live with report cleaning, which uses
// them too; this script reads them from the data folder and checks git.
export { collectTerms, findLeaks, matcher };


const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function dataDirectory(env = process.env, cwd = process.cwd(), platform = process.platform, home = homedir(), checkout = root) {
  if (env.LANE_DATA_DIR) return resolve(cwd, env.LANE_DATA_DIR);
  for (const base of [cwd, checkout]) if (existsSync(join(base, ".local", "config.json"))) return join(base, ".local");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Application Lane");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Application Lane");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "application-lane");
}

function readLines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")) : [];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function loadTerms(dir) {
  const state = readJson(join(dir, "state.json"));
  const queue = readJson(join(dir, "queue.json"));
  const applications = Array.isArray(queue?.applications) ? queue.applications : Object.values(queue?.applications || {});
  return collectTerms({ profile: state?.profile, applications, extra: readLines(join(dir, "leak-terms.txt")), allow: readLines(join(dir, "leak-allow.txt")) });
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });

// Added lines of a unified diff, as [{ where: "file:line", line }], plus each new path.
export function addedLines(diff) {
  const lines = [];
  let file = "";
  let at = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      if (file !== "/dev/null") lines.push({ where: `${file} (its path)`, line: file });
    } else if (line.startsWith("@@")) at = Number(/\+(\d+)/.exec(line)?.[1] || 0);
    else if (line.startsWith("+")) lines.push({ where: `${file}:${at++}`, line: line.slice(1) });
    else if (!line.startsWith("-") && !line.startsWith("\\")) at++;
  }
  return lines;
}

function messageLines(message, label) {
  return message.split("\n").map((line, index) => ({ where: `${label}:${index + 1}`, line })).filter(({ line }) => !line.startsWith("#"));
}

function rangeLines(range, cwd) {
  const lines = addedLines(git(["diff", "-U0", "--no-color", "--no-ext-diff", "--text", range], cwd));
  for (const sha of git(["rev-list", range], cwd).split("\n").filter(Boolean)) {
    const short = sha.slice(0, 8);
    lines.push(...messageLines(git(["log", "-1", "--format=%B", sha], cwd), `commit ${short} message`));
    lines.push(...messageLines(git(["log", "-1", "--format=%an <%ae>%n%cn <%ce>", sha], cwd), `commit ${short} author`));
  }
  return lines;
}

// The ranges a pre-push hook's stdin names: what each pushed ref adds to the remote.
function pushRanges(input, cwd) {
  const zero = /^0+$/;
  const ranges = [];
  for (const row of input.split("\n").filter(Boolean)) {
    const [, local, , remote] = row.split(" ");
    if (!local || zero.test(local)) continue;
    if (remote && !zero.test(remote)) ranges.push(`${remote}..${local}`);
    else {
      const first = git(["rev-list", "--reverse", local, "--not", "--remotes"], cwd).split("\n").filter(Boolean)[0];
      if (first) ranges.push(git(["rev-list", "--parents", "-n", "1", first], cwd).trim().split(" ")[1] ? `${first}~1..${local}` : local);
    }
  }
  return ranges;
}

// Word lists (the spelling dictionary) hold every company that is also a word.
const wordLists = /^src\/server\/words\//;

function fileLines(dir) {
  return listedFileLines(dir, git(["ls-files", "-z"], dir).split("\0").filter(Boolean));
}

// Each line of the given files (paths from dir), and each path; binary files by path only.
export function listedFileLines(dir, files) {
  const lines = [];
  for (const file of files) {
    lines.push({ where: `${file} (its path)`, line: file });
    let content;
    try {
      content = readFileSync(join(dir, file));
    } catch {
      continue;
    }
    if (content.includes(0)) continue;
    content.toString("utf8").split(/\r?\n/).forEach((line, index) => lines.push({ where: `${file}:${index + 1}`, line }));
  }
  return lines;
}

// For the public export: what of the applicant's own details the given files hold.
export function leakHits(dir, files, dataDir = dataDirectory()) {
  const terms = existsSync(join(dataDir, "state.json")) ? loadTerms(dataDir) : [];
  return { terms: terms.length, hits: findLeaks(listedFileLines(dir, files).filter(({ where }) => !wordLists.test(where)), terms) };
}

function main(argv) {
  const args = argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dir = option("--data-dir") ? resolve(option("--data-dir")) : dataDirectory();
  const terms = existsSync(join(dir, "state.json")) ? loadTerms(dir) : [];
  if (args.includes("--terms")) {
    for (const { kind, term } of terms) console.log(`${kind}: ${term}`);
    console.log(`${terms.length} terms from ${dir}`);
    return 0;
  }
  if (!terms.length) {
    console.error(`leak check: no profile in ${dir}, so nothing to look for; skipped.`);
    return 0;
  }
  const cwd = process.cwd();
  let lines;
  if (args.includes("--staged")) {
    lines = addedLines(git(["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--text"], cwd));
    lines.push(...messageLines(git(["var", "GIT_AUTHOR_IDENT"], cwd).replace(/>.*$/s, ">"), "author"));
  } else if (option("--message")) lines = messageLines(readFileSync(option("--message"), "utf8"), "commit message");
  else if (option("--range")) lines = rangeLines(option("--range"), cwd);
  else if (args.includes("--push")) lines = pushRanges(readFileSync(0, "utf8"), cwd).flatMap((range) => rangeLines(range, cwd));
  else if (args.includes("--all")) {
    const target = args[args.indexOf("--all") + 1];
    lines = fileLines(target && !target.startsWith("--") ? resolve(target) : cwd);
  } else {
    console.error("Usage: node scripts/leak-check.mjs --staged | --message <file> | --push | --range <a>..<b> | --all [<dir>] | --terms  [--data-dir <dir>]");
    return 2;
  }
  const hits = findLeaks(lines.filter(({ where }) => !wordLists.test(where)), terms);
  if (!hits.length) {
    console.log(`leak check: clean (${lines.length} lines, ${terms.length} terms).`);
    return 0;
  }
  if (hits.length <= 50 || args.includes("--every")) for (const { where, kind, term } of hits) console.error(`  ${where}: ${kind} "${term}"`);
  else {
    // Many: one line a term, with where it first appears (--every lists them all).
    const byTerm = new Map();
    for (const hit of hits) byTerm.set(hit.term, [...(byTerm.get(hit.term) || []), hit]);
    for (const [term, found] of [...byTerm].sort((a, b) => b[1].length - a[1].length))
      console.error(`  ${found[0].kind} "${term}": ${found.length} line(s), first ${found[0].where}`);
  }
  console.error(`\nleak check: ${hits.length} personal detail(s) found. Replace them with neutral ones (Alex Rivera, Acme, Penn State),`);
  console.error(`or list a term that is fine to commit in ${join(dir, "leak-allow.txt")}.`);
  return 1;
}

// Run as a script only: bundled into the backend (src/server/clean-report.ts),
// import.meta.url is the bundle's, which node also runs.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && /leak-check\.mjs$/.test(process.argv[1])) process.exitCode = main(process.argv);
