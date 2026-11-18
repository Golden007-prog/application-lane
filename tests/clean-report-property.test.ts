import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanReport, ReportNotClean } from "../src/server/clean-report";
import type { IssueReport } from "../src/shared/model";

// Many invented applicants, each with details scattered through a report in
// a random case and phone format: whatever the mix, the cleaned report holds
// none of them, or cleaning refuses (ReportNotClean) and nothing is shared.
// Seeded, so a failure names the seed that reproduces it.

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  const pick = <T,>(items: T[]) => items[int(0, items.length - 1)];
  return { next, int, pick };
}
type Random = ReturnType<typeof random>;

// Invented words: no real name, place or company by accident.
const word = (r: Random, syllables = r.int(2, 3)) => {
  let text = "";
  for (let i = 0; i < syllables; i++) text += r.pick([..."bdfgkmnprstvz"]) + r.pick([..."aeiou"]) + (r.next() < 0.4 ? r.pick([..."lnrs"]) : "");
  return text[0].toUpperCase() + text.slice(1);
};
const digits = (r: Random, count: number) => Array.from({ length: count }, () => r.int(0, 9)).join("");

function applicant(r: Random) {
  const firstName = word(r);
  const lastName = word(r, 3);
  const area = `${r.int(2, 9)}${digits(r, 2)}`;
  const exchange = `${r.int(2, 9)}${digits(r, 2)}`;
  const line = digits(r, 4);
  const domain = `${word(r).toLowerCase()}.test`;
  const employer = `${word(r)} ${r.pick(["Analytics", "Labs", "Works", "Group"])}`;
  const school = `${word(r)} ${r.pick(["University", "College", "Institute"])}`;
  const city = word(r);
  return {
    profile: {
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`,
      phone: `(${area}) ${exchange}-${line}`,
      address: `${r.int(100, 9999)} ${word(r)} ${r.pick(["St", "Ave", "Ct", "Rd"])}`,
      city,
      postalCode: digits(r, 5),
      currentCompany: employer,
      work: [{ organization: employer }],
      education: [{ organization: school }],
    },
    phoneParts: [area, exchange, line] as const,
    otherCompany: `${word(r)} ${word(r)}`,
  };
}

const cased = (r: Random, text: string) => r.pick([text, text.toUpperCase(), text.toLowerCase()]);
const phoneAs = (r: Random, [a, e, n]: readonly [string, string, string]) =>
  r.pick([`(${a}) ${e}-${n}`, `${a}.${e}.${n}`, `${a}-${e}-${n}`, `${a}${e}${n}`, `+1 ${a} ${e} ${n}`]);

function reportFor(r: Random, person: ReturnType<typeof applicant>): IssueReport {
  const p = person.profile;
  const details = [
    `${p.firstName} ${p.lastName}`,
    p.email,
    phoneAs(r, person.phoneParts),
    p.address,
    p.city,
    p.postalCode,
    p.currentCompany,
    p.education[0].organization,
    person.otherCompany,
  ];
  const scattered = () => cased(r, r.pick(details));
  const html = Array.from({ length: 12 }, (_, i) =>
    r.pick([`<p>${scattered()}</p>`, `<input name="f${i}" data-lane-value="${scattered()}">`, `<option selected>${scattered()}</option>`, `<span title="${scattered()}">x</span>`]),
  ).join("\n");
  const url = "https://example-ats.test/apply/R100";
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: 1,
    category: "wrong-value",
    note: `${scattered()} went into the wrong box, near ${scattered()}; also ${scattered()}.`,
    applicationId: "00000000-0000-4000-8000-000000000002",
    application: { title: "Data Analyst", company: "Placeholder Employer", workflowStage: "applying" as any, status: "filled" as any, operation: 1, missing: [], attempts: [] },
    tab: { tabId: 7, url, title: "Data Analyst", ats: "workday" },
    extension: { version: "0.1.0", contentVersion: "test" },
    frames: [
      {
        url,
        html,
        observation: {
          url,
          title: "Data Analyst",
          description: `Contact: ${scattered()}`,
          fields: Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, label: `Field ${i}`, kind: "text", value: scattered() })),
        } as any,
      },
    ],
  } as IssueReport;
}

// What must not survive: each part of each detail that names the applicant.
function leftovers(shared: string, person: ReturnType<typeof applicant>): string[] {
  const p = person.profile;
  const lower = shared.toLowerCase();
  const words = [p.firstName, p.lastName, p.email, p.address, p.city, p.currentCompany, p.education[0].organization, person.otherCompany];
  const found = words.filter((text) => lower.includes(text.toLowerCase()));
  const [a, e, n] = person.phoneParts;
  if (new RegExp(`${a}\\D{0,3}${e}\\D{0,2}${n}`).test(shared)) found.push("phone");
  if (new RegExp(`(?<!\\d)${p.postalCode}(?!\\d)`).test(shared)) found.push("postal code");
  return found;
}

test("cleaning leaves none of an applicant's details, for many invented applicants", () => {
  let refused = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const r = random(seed);
    const person = applicant(r);
    const report = reportFor(r, person);
    let shared: string;
    try {
      shared = JSON.stringify(cleanReport(report, { profile: person.profile, applications: [{ company: person.otherCompany }] }).report);
    } catch (error) {
      if (!(error instanceof ReportNotClean)) throw error;
      refused++;
      continue;
    }
    assert.deepEqual(leftovers(shared, person), [], `seed ${seed}: details left in the cleaned report`);
  }
  // Refusing is safe, but a cleaner that refuses everything cleans nothing.
  assert.ok(refused < 15, `${refused} of 150 reports were refused`);
});
