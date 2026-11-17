import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanReport } from "../src/server/clean-report";
import type { IssueReport } from "../src/shared/model";

// A made-up applicant whose details a page, a field and the note all show.
const profile = {
  firstName: "Morgan",
  lastName: "Ellery",
  email: "morgan.ellery@mailbox.test",
  phone: "(602) 555-0143",
  address: "4410 W. Juniper Ct",
  city: "Prescott",
  postalCode: "86305",
  linkedin: "https://www.linkedin.com/in/morgan-ellery-42",
  currentCompany: "Harborview Analytics",
  work: [{ organization: "Harborview Analytics" }, { organization: "Quillfeather Studio" }],
  education: [{ organization: "Virginia Tech" }],
  references: [{ name: "Dana Whitfield", email: "dana.w@mailbox.test", phone: "928-555-0177" }],
};
const applications = [
  { company: "Fourth Coffee", url: "https://fourthcoffee.wd5.myworkdayjobs.com/en-US/External/job/Data-Analyst_R100" },
  { company: "Trey Research", url: "https://treyresearch.wd1.myworkdayjobs.com/careers/job/R200" },
];

function report(): IssueReport {
  const html = `<form><h2>Morgan Ellery</h2><p>MORGAN ELLERY · morgan.ellery@mailbox.test · 602.555.0143</p>
<input name="address" data-lane-value="4410 W. Juniper Ct"><input name="city" data-lane-value="Prescott"><input name="zip" data-lane-value="86305">
<input type="file" data-lane-value="Morgan_Ellery_Resume.pdf"><a href="https://linkedin.com/in/morgan-ellery-42">LinkedIn</a>
<input name="employer" data-lane-value="Harborview Analytics"><select name="school"><option selected>Virginia Tech</option></select>
<input name="reference" data-lane-value="Dana Whitfield, (928) 555-0177"><p>Also applied: Trey Research</p></form>`;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: 1,
    category: "wrong-value",
    note: "Morgan's phone 602-555-0143 went into the wrong box; it worked at Trey Research.",
    applicationId: "00000000-0000-4000-8000-000000000002",
    application: { title: "Data Analyst", company: "Fourth Coffee", workflowStage: "applying" as any, status: "filled" as any, operation: 1, missing: [], attempts: [] },
    tab: { tabId: 7, url: applications[0].url, title: "Data Analyst - Fourth Coffee", ats: "workday" },
    extension: { version: "0.1.0", contentVersion: "test" },
    recordingId: "00000000-0000-4000-8000-000000000003",
    network: { entries: 40, fromLoad: true },
    images: ["00000000.image-1.png"],
    frames: [
      {
        url: applications[0].url,
        html,
        observation: {
          url: applications[0].url,
          title: "Data Analyst",
          description: "Questions? Write to Morgan Ellery's recruiter.",
          fields: [
            { id: "f1", label: "First Name", kind: "text", value: "Morgan" },
            { id: "f2", label: "Phone", kind: "tel", value: "6025550143" },
            { id: "f3", label: "Email", kind: "email", value: "Morgan.Ellery@mailbox.test" },
          ],
        } as any,
      },
    ],
  };
}

const details = [
  "morgan", "ellery", "mailbox.test", "4410", "juniper", "prescott", "86305", "morgan-ellery-42",
  "harborview", "quillfeather", "virginia tech", "dana", "whitfield", "trey research", "treyresearch",
];
const digitsOf = (text: string) => text.replace(/\D/g, "");

test("a cleaned report holds none of the applicant's details, in any case or format", () => {
  const { report: cleaned } = cleanReport(report(), { profile, applications });
  const shared = JSON.stringify(cleaned);
  for (const detail of details) assert.ok(!shared.toLowerCase().includes(detail), `${detail} is still in the report`);
  // Phone numbers however they were written: digits alone, with spaces, dots or dashes.
  for (const phone of ["6025550143", "9285550177"]) assert.ok(!digitsOf(shared).includes(phone), `${phone} is still in the report`);
});

test("the report's own company and site stay, so the problem can be reproduced", () => {
  const { report: cleaned } = cleanReport(report(), { profile, applications });
  assert.equal(cleaned.application?.company, "Fourth Coffee");
  assert.equal(cleaned.tab.url, applications[0].url);
  assert.equal(cleaned.frames[0].url, applications[0].url);
});

test("stand-ins keep how a detail was written", () => {
  const { report: cleaned, replaced } = cleanReport(report(), { profile, applications });
  const html = cleaned.frames[0].html!;
  assert.match(html, /<h2>Alex Rivera<\/h2>/);
  assert.match(html, /ALEX RIVERA · alex\.rivera@example\.com · 555\.010\.0199/);
  assert.match(html, /Alex_Rivera_Resume\.pdf/);
  assert.match(html, /\(555\) 010-0199/);
  assert.equal(cleaned.frames[0].observation?.fields[1].value, "5550100199");
  assert.match(cleaned.note, /^Alex's phone 555-010-0199/);
  assert.ok(replaced.name > 0 && replaced.phone > 0 && replaced["company applied to"] > 0);
});

test("the network log, the recording and the screenshots are left out", () => {
  const { report: cleaned, removed } = cleanReport(report(), { profile, applications });
  assert.equal(cleaned.network, undefined);
  assert.equal(cleaned.recordingId, undefined);
  assert.equal(cleaned.images, undefined);
  assert.deepEqual(removed, ["the page's network log", "the recording of the fill", "the screenshot"]);
});

test("an applicant whose details match the stand-ins does not get them back", () => {
  const rename = (text: string) =>
    text.replace(/morgan/gi, (word) => (word === "MORGAN" ? "ALEX" : word[0] === "M" ? "Alex" : "alex")).replace(/ellery/gi, (word) => (word === "ELLERY" ? "RIVERA" : word[0] === "E" ? "Rivera" : "rivera"));
  const alex = JSON.parse(rename(JSON.stringify(profile)));
  const { report: cleaned } = cleanReport(JSON.parse(rename(JSON.stringify(report()))), { profile: alex, applications });
  const shared = JSON.stringify(cleaned).toLowerCase();
  assert.ok(!shared.includes("alex") && !shared.includes("rivera"));
});

test("a date of birth is replaced however the form writes it", () => {
  const base = report();
  base.frames[0].html += `<input name="dob" data-lane-value="04/07/1994"><span>4/7/1994</span><span>1994-04-07</span>`;
  const { report: cleaned } = cleanReport(base, { profile: { ...profile, dateOfBirth: "1994-04-07" }, applications });
  assert.ok(!/1994/.test(cleaned.frames[0].html!), cleaned.frames[0].html);
});

test("terms listed in leak-terms.txt are removed too", () => {
  const base = report();
  base.note += " My old team at Larkspur Grove did this by hand.";
  const { report: cleaned } = cleanReport(base, { profile, applications, extra: ["Larkspur Grove"] });
  assert.ok(!cleaned.note.includes("Larkspur"));
});

// A page's text as the capture reads it runs a heading into the label after
// it: "Morgan ElleryEmail", where a whole-word match never sees "Ellery".
test("details run together with the words around them are replaced too", () => {
  const glued = report();
  (glued.frames[0].observation as any).description = "Morgan ElleryEmailPhoneHarborview AnalyticsSubmitTrey ResearchApply";
  glued.note = "The heading showed EmailMorgan and ELLERY.";
  const { report: cleaned } = cleanReport(glued, { profile, applications });
  const shared = JSON.stringify(cleaned);
  for (const detail of details) assert.ok(!shared.toLowerCase().includes(detail), `${detail} is still in the report`);
  assert.equal((cleaned.frames[0].observation as any).description, "Alex RiveraEmailPhoneNorthwind LabsSubmitContosoApply");
  // Words that only begin with a detail stay as they are.
  const words = report();
  words.note = "Morgantown and Elleryson are other places.";
  assert.equal(cleanReport(words, { profile, applications }).report.note, "Morgantown and Elleryson are other places.");
});

test("a cleaned report drops the profile fingerprint and revision", () => {
  const withStamp = { ...report(), profile: { revision: 7, fingerprint: "ab".repeat(32) } };
  const { report: cleaned } = cleanReport(withStamp, { profile, applications });
  assert.equal("profile" in cleaned, false);
  const text = JSON.stringify(cleaned);
  assert.ok(!text.includes("ab".repeat(32)) && !text.includes("fingerprint") && !text.includes("revision"));
});
