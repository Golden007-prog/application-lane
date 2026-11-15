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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function dataDirectory(env = process.env, cwd = process.cwd(), platform = process.platform, home = homedir(), checkout = root) {
  if (env.LANE_DATA_DIR) return resolve(cwd, env.LANE_DATA_DIR);
  for (const base of [cwd, checkout]) if (existsSync(join(base, ".local", "config.json"))) return join(base, ".local");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Application Lane");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Application Lane");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "application-lane");
}

// Job-site vendors, and words that are hosts' first labels on many sites:
// never a term on their own, even when an application's company shares the name.
const vendors = new Set(
  [
    ...(existsSync(join(root, "src/engine/config/sites")) ? readdirSync(join(root, "src/engine/config/sites")).map((name) => name.replace(/\.json$/, "")) : []),
    "workday", "myworkdayjobs", "greenhouse", "lever", "icims", "taleo", "oracle", "successfactors", "smartrecruiters", "ashby", "workable", "jobvite",
    "bamboohr", "paylocity", "rippling", "adp", "ultipro", "ukg", "phenom", "eightfold", "avature", "jazzhr", "breezy", "recruitee", "teamtailor",
    "www", "jobs", "careers", "career", "apply", "ats", "connect", "account", "accounts", "login", "auth", "sso", "embed", "portal", "my", "boards", "job-boards", "app", "recruiting", "hire", "talent", "join", "work", "en", "us", "wd1", "wd3", "wd5", "fa",
  ].map((word) => word.toLowerCase()),
);

const text = (value) => (typeof value === "string" ? value.trim() : "");

// What a profile link identifies: the handle after the host ("linkedin.com/in/<handle>").
function linkTerms(value) {
  const link = text(value).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  if (!link) return [];
  const [host, ...path] = link.split("/");
  const handle = path.filter(Boolean).pop();
  const terms = [];
  if (path.length) terms.push(link);
  if (handle && handle.length >= 3 && !["in", "pub", "profile"].includes(handle.toLowerCase())) terms.push(handle);
  // A personal site is its own host.
  if (!path.length && host.includes(".") && !/(^|\.)(linkedin|github|gitlab)\.com$/i.test(host)) terms.push(host);
  return terms;
}

// A school's or employer's initials ("Penn State University" -> PSU), matched with case.
function initials(name) {
  const words = name.split(/[\s,&/-]+/).filter((word) => /^[A-Z]/.test(word) && !/^(Of|The|And|At|For|In)$/i.test(word));
  return words.length >= 2 ? words.map((word) => word[0]).join("") : "";
}

function hostTerms(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const label = host.split(".")[0];
    return host.split(".").length >= 3 && !vendors.has(label) && !/^career\d*$/.test(label) && label.length >= 3 ? [label] : [];
  } catch {
    return [];
  }
}

// [{ term, kind, cased?, digits? }] from the data folder's contents.
export function collectTerms({ profile = {}, applications = [], extra = [], allow = [] } = {}) {
  const terms = [];
  const add = (term, kind, options = {}) => {
    const value = text(term);
    if (value.length >= (options.min ?? 3)) terms.push({ term: value, kind, ...options });
  };
  const phone = (value, kind) => {
    const digits = text(value).replace(/\D/g, "");
    if (digits.length >= 7) terms.push({ term: digits.slice(-10), kind, digits: true });
  };
  for (const key of ["firstName", "lastName", "middleName", "preferredName"]) add(profile[key], "name");
  if (text(profile.firstName) && text(profile.lastName)) add(`${text(profile.firstName)} ${text(profile.lastName)}`, "name");
  add(profile.email, "email");
  add(text(profile.email).split("@")[0], "email", { min: 4 });
  phone(profile.phone, "phone");
  for (const key of ["address", "addressLine2"]) add(profile[key], "address", { min: 5 });
  add(profile.postalCode, "address", { min: 5 });
  add(profile.city, "address", { min: 4 });
  add(profile.dateOfBirth, "date of birth", { min: 6 });
  add(profile.currentCompany, "employer");
  for (const key of ["linkedin", "github", "website"]) for (const term of linkTerms(profile[key])) add(term, "profile link");
  for (const row of profile.work || []) {
    add(row.organization, "employer");
    add(row.address, "address", { min: 5 });
    const short = initials(text(row.organization));
    if (short.length >= 3) add(short, "employer", { cased: true });
  }
  for (const row of profile.education || []) {
    add(row.organization, "school");
    const short = initials(text(row.organization));
    if (short.length >= 3) add(short, "school", { cased: true });
  }
  for (const row of profile.references || []) {
    add(row.name, "reference");
    add(row.email, "reference");
    phone(row.phone, "reference");
  }
  // A one-word company is often an everyday word ("Atlas", "esb"): it is
  // looked for as a name is written (Atlas, ATLAS), and up to three letters
  // only in capitals (ESB), so src/atlas and npx esb are not read as it.
  const company = (value) => {
    const name = text(value);
    if (/^[0-9a-f]{16,}$/i.test(name.replace(/[\s-]/g, ""))) return;
    if (/\s/.test(name)) add(name, "company applied to");
    // A label that is a number or an id (career8, a hex tenant) names no one.
    else if (name.length >= 3 && !/\d$/.test(name) && !/^[0-9a-f-]{8,}$/i.test(name)) add(name, "company applied to", { named: true });
  };
  for (const application of applications) {
    company(application.company);
    for (const url of [application.url, application.postingUrl, application.sourceUrl]) for (const label of hostTerms(url)) company(label);
  }
  // A one-word listed term is matched as a company's name is (Harbor, not harbor).
  for (const line of extra) add(line, "listed term", /\s/.test(text(line)) ? {} : { named: true });
  const allowed = new Set(allow.map((line) => text(line).toLowerCase()).filter(Boolean));
  const seen = new Set();
  return terms.filter(({ term, digits }) => {
    const key = term.toLowerCase();
    if (seen.has(key) || allowed.has(key) || (!digits && vendors.has(key))) return false;
    seen.add(key);
    return true;
  });
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The pattern a term is looked for with; report cleaning (src/server/clean-report.ts) replaces what it matches.
export function matcher({ term, cased, digits, named }) {
  if (named) {
    const word = escape(term.toLowerCase());
    // As written too when that has capitals of its own (iCIMS), never all lower case.
    const forms = term.length <= 3 ? [word.toUpperCase()] : [word[0].toUpperCase() + word.slice(1), word.toUpperCase(), ...(/[A-Z]/.test(term) ? [escape(term)] : [])];
    const named = `(?<![\\p{L}\\p{N}])(?:${[...new Set(forms)].join("|")})(?![\\p{L}\\p{N}])`;
    // In any case inside an address: a host's label (contoso.wd1…) or a path segment (/contoso/jobs).
    const any = [...word].map((char) => (/[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : char)).join("");
    const inUrl = `(?<![\\w.-])${any}\\.[a-z][\\w-]*\\.|[\\w-]\\.[a-z]{2,}(?:/[^\\s/"']+)*/${any}(?=[/?#"'\\s]|$)`;
    return new RegExp(`${named}|${inUrl}`, "u");
  }
  if (digits) return new RegExp(`(?<!\\d)${[...term].join("[\\s().+-]{0,3}")}(?!\\d)`);
  const body = term.split(/\s+/).map(escape).join("[\\s_-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, cased ? "u" : "iu");
}

// [{ where, kind, term }] for each line of `lines` ([{ where, line }]) a term matches.
export function findLeaks(lines, terms) {
  const tests = terms.map((term) => ({ ...term, pattern: matcher(term) }));
  const hits = [];
  for (const { where, line } of lines) for (const { pattern, kind, term } of tests) if (pattern.test(line)) hits.push({ where, kind, term });
  return hits;
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
