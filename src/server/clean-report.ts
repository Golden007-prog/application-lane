// A report made fit to share: the applicant's own details are replaced with
// neutral ones before a report leaves their machine (to a GitHub issue, say),
// and the parts that cannot be cleaned are left out.
//
// The capture already keeps passwords, fields that look secret and URL query
// strings out of a report (content.ts). What is left is the applicant: their
// name, email, phone, address, schools, employers, references and profile
// links, wherever a page or the note shows them, and the other companies in
// their queue. The terms are the leak check's (scripts/leak-check.mjs), so
// what it would stop in a commit is what is cleaned here; the report's own
// company and its site stay, since the problem cannot be reproduced without
// them. After replacing, the leak check reads the result again, and a report
// with anything left is refused rather than shared.

import { collectTerms, findLeaks, matcher, type LeakTerm } from "../../scripts/leak-check.mjs";
import type { IssueReport } from "../shared/model";

export type CleanInput = {
  profile?: Record<string, any>;
  // The queue's applications: their companies and addresses are the
  // applicant's too, apart from the report's own.
  applications?: Array<Record<string, any>>;
  // The data folder's leak-terms.txt and leak-allow.txt.
  extra?: string[];
  allow?: string[];
};

export type CleanedReport = {
  report: IssueReport;
  // How many of each kind of detail were replaced ("name": 12).
  replaced: Record<string, number>;
  // What was left out, in words for the applicant to read before sharing.
  removed: string[];
};

export class ReportNotClean extends Error {
  constructor(readonly kinds: string[]) {
    super(`The report still holds details that could not be replaced (${kinds.join(", ")}), so it was not cleaned for sharing.`);
  }
}

// Neutral stand-ins, the same ones the repository's tests use.
const NAME = { first: "Alex", middle: "Jordan", last: "Rivera" };
const EMAIL = "alex.rivera@example.com";
const PHONE = "5550100199";
const ADDRESS = { street: "100 E. Mill Way", city: "Flagstaff", postal: "86001" };
const EMPLOYERS = ["Northwind Labs", "Pixelforge", "Brightline.AI", "Fabrikam", "Woodgrove"];
const SCHOOLS = ["Michigan State University", "Penn State University", "Virginia Tech"];
const COMPANIES = ["Contoso", "Litware", "Tailspin", "Proseware", "Adatum", "Lucerne", "Wingtip"];
const REFERENCE = { name: "Jordan Lee", email: "jordan.lee@example.com" };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const lower = (value: string) => value.toLowerCase();

// The stand-in for each term: what it is in the profile where that says
// more than its kind does (a first name, not just a name).
function standIns(terms: LeakTerm[], profile: Record<string, any>): Map<string, string> {
  const known = new Map<string, string>();
  const set = (value: unknown, standIn: string) => {
    const key = lower(text(value));
    if (key && !known.has(key)) known.set(key, standIn);
  };
  set(`${text(profile.firstName)} ${text(profile.lastName)}`, `${NAME.first} ${NAME.last}`);
  set(profile.firstName, NAME.first);
  set(profile.preferredName, NAME.first);
  set(profile.middleName, NAME.middle);
  set(profile.lastName, NAME.last);
  set(profile.email, EMAIL);
  set(text(profile.email).split("@")[0], EMAIL.split("@")[0]);
  set(profile.postalCode, ADDRESS.postal);
  set(profile.city, ADDRESS.city);
  for (const row of profile.references || []) {
    set(row.name, REFERENCE.name);
    set(row.email, REFERENCE.email);
  }
  const counters: Record<string, number> = {};
  const next = (list: string[], kind: string) => list[(counters[kind] = (counters[kind] ?? -1) + 1) % list.length];
  const result = new Map<string, string>();
  for (const term of terms) {
    const key = lower(term.term);
    let standIn = known.get(key);
    if (!standIn)
      switch (term.kind) {
        case "name":
          standIn = `${NAME.first} ${NAME.last}`;
          break;
        case "email":
          standIn = term.term.includes("@") ? EMAIL : EMAIL.split("@")[0];
          break;
        case "address":
          standIn = ADDRESS.street;
          break;
        case "date of birth":
          standIn = "1990-01-01";
          break;
        case "employer": {
          const name = next(EMPLOYERS, "employer");
          standIn = term.cased ? acronym(name) : name;
          break;
        }
        case "school": {
          const name = next(SCHOOLS, "school");
          standIn = term.cased ? acronym(name) : name;
          break;
        }
        case "reference":
          standIn = term.term.includes("@") ? REFERENCE.email : REFERENCE.name;
          break;
        case "profile link":
          standIn = term.term.includes("/") ? "example.com/alex-rivera" : term.term.includes(".") ? "example.com" : "alex-rivera";
          break;
        case "company applied to":
          standIn = next(COMPANIES, "company");
          break;
        default:
          standIn = "[removed]";
      }
    // A stand-in that is itself one of the applicant's details (their name
    // really is Alex) would put that detail back.
    if (terms.some((other) => matcher(other).test(standIn!))) standIn = "[removed]";
    result.set(key, standIn);
  }
  return result;
}

// A date of birth as forms write it, beyond how the profile keeps it
// (1990-04-07): 04/07/1990, 4/7/1990, 07/04/1990, 04-07-1990, 04.07.1990.
function birthDates(value: unknown): LeakTerm[] {
  const date = text(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!date) return [];
  const [, year, month, day] = date;
  const forms = [`${month}/${day}/${year}`, `${+month}/${+day}/${year}`, `${day}/${month}/${year}`, `${+day}/${+month}/${year}`, `${month}-${day}-${year}`, `${day}.${month}.${year}`];
  return [...new Set(forms)].map((term) => ({ term, kind: "date of birth" }));
}

function acronym(name: string) {
  const letters = name.split(/[\s.]+/).filter((word) => /^[A-Z]/.test(word)).map((word) => word[0]).join("");
  return letters.length >= 2 ? letters : name;
}

// A stand-in written as the original was: in capitals, in lower case, or as given.
function shaped(original: string, standIn: string) {
  if (original === original.toUpperCase() && original !== original.toLowerCase()) return standIn.toUpperCase();
  if (original === original.toLowerCase() && original !== original.toUpperCase()) return standIn.toLowerCase();
  return standIn;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A term in page text run together with the words beside it: a heading and
// the label after it read "Morgan ElleryEmail", where the leak check's word
// edges never find "Ellery". There a capital after a small letter is an edge
// too. As written and in title case, as names and companies are shown.
function glued(term: LeakTerm): RegExp | undefined {
  if (term.digits || term.term.trim().length < 3) return;
  const words = term.term.trim().split(/\s+/);
  const title = words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
  const forms = [...new Set([words, title].map((form) => form.map(escape).join("[\\s_-]+")))];
  return new RegExp(`(?:(?<![\\p{L}\\p{N}])|(?<=\\p{Ll}))(?:${forms.join("|")})(?:(?![\\p{L}\\p{N}])|(?=\\p{Lu}))`, "gu");
}

// Each match of a term in `value`, replaced. A match can carry more than the
// term (a company's host label "contoso.wd1."), so only the term in it changes.
function replaceTerm(value: string, term: LeakTerm, standIn: string, count: () => void): string {
  const pattern = matcher(term);
  const everywhere = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  if (term.digits) {
    // Each digit of the number in turn, keeping how it was written ((480) 555-…).
    return value.replace(everywhere, (match) => {
      count();
      const digits = PHONE.slice(-term.term.length);
      let at = 0;
      return match.replace(/\d/g, () => digits[at++] ?? "0");
    });
  }
  const inside = new RegExp(term.term.split(/\s+/).map(escape).join("[\\s_-]+"), "i");
  // Joined as the original was (Morgan_Ellery_Resume.pdf -> Alex_Rivera_Resume.pdf).
  const swap = (found: string) => {
    const gaps = found.match(/[\s_-]+/g) ?? [];
    const words = standIn.split(" ");
    const joined = gaps.length === words.length - 1 ? words.map((word, at) => word + (gaps[at] ?? "")).join("") : standIn;
    return shaped(found, joined);
  };
  const runTogether = glued(term);
  if (runTogether)
    value = value.replace(runTogether, (found) => {
      count();
      return swap(found);
    });
  return value.replace(everywhere, (match) => {
    count();
    return match.replace(inside, swap);
  });
}

// Every string in a value, replaced by `change`; other values as they are.
function mapStrings<T>(value: T, change: (text: string) => string): T {
  if (typeof value === "string") return change(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, change)])) as T;
  return value;
}

// The terms that name the report's own company and site, which stay.
function keptTerms(report: IssueReport): Set<string> {
  const urls = [report.tab?.url, ...report.frames.map((frame) => frame.url)].filter(Boolean);
  const own = collectTerms({ applications: [{ company: report.application?.company, url: urls[0] }, ...urls.slice(1).map((url) => ({ url }))] });
  return new Set(own.map((term) => lower(term.term)));
}

export function cleanReport(report: IssueReport, input: CleanInput): CleanedReport {
  const profile = input.profile ?? {};
  const kept = keptTerms(report);
  const terms = [
    ...collectTerms({ profile, applications: input.applications ?? [], extra: input.extra ?? [], allow: input.allow ?? [] }).filter(
      (term) => !(term.kind === "company applied to" && kept.has(lower(term.term))),
    ),
    ...birthDates(profile.dateOfBirth),
  ];
  const standIn = standIns(terms, profile);
  // Longest first, so a full name is replaced before the first name in it.
  const ordered = [...terms].sort((a, b) => b.term.length - a.term.length);
  const replaced: Record<string, number> = {};

  // Left out: the network log (cookies, posted answers, other requests), the
  // recording, the screenshots (pictures of the applicant's own screen), and
  // what the fixer made of it, which is this machine's business.
  const { network, recordingId, images, fixer, profile: used, ...rest } = report;
  const removed: string[] = [];
  if (network) removed.push("the page's network log");
  if (recordingId) removed.push("the recording of the fill");
  if (images?.length) removed.push(images.length === 1 ? "the screenshot" : `${images.length} screenshots`);
  void fixer;
  // Which profile the fill used (its revision and fingerprint) is this machine's business.
  void used;

  const cleaned = mapStrings(rest as IssueReport, (value) => {
    let result = value;
    for (const term of ordered)
      result = replaceTerm(result, term, standIn.get(lower(term.term)) ?? "[removed]", () => {
        replaced[term.kind] = (replaced[term.kind] ?? 0) + 1;
      });
    return result;
  });

  // Read again as the leak check reads a commit: anything still there (a
  // stand-in that was itself a term, say) refuses the report.
  const lines = mapLines(cleaned);
  const left = [
    ...findLeaks(lines, terms),
    ...terms.filter((term) => lines.some(({ line }) => { const pattern = glued(term); return pattern ? new RegExp(pattern.source, "u").test(line) : false; })),
  ];
  if (left.length) throw new ReportNotClean([...new Set(left.map((hit) => hit.kind))]);
  return { report: cleaned, replaced, removed };
}

function mapLines(report: IssueReport) {
  const lines: { where: string; line: string }[] = [];
  mapStrings(report, (value) => {
    for (const line of value.split("\n")) lines.push({ where: "report", line });
    return value;
  });
  return lines;
}
