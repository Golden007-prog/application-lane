// The applicant's details as terms to look for, and how each is matched:
// shared by report cleaning (clean-report.ts) and the leak check
// (scripts/leak-check.mjs). Plain JavaScript, so that script runs on Node
// alone.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The site rules' folder: each site's name is a vendor's. (Absent beside a
// bundled backend; the list below names them all as well.)
const sites = fileURLToPath(new URL("../engine/config/sites", import.meta.url));

// Job-site vendors, and words that are hosts' first labels on many sites:
// never a term on their own, even when an application's company shares the name.
const vendors = new Set(
  [
    ...(existsSync(sites) ? readdirSync(sites).map((name) => name.replace(/\.json$/, "")) : []),
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
