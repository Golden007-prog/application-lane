import assert from "node:assert/strict";
import { test } from "node:test";
import { proposals } from "../src/shared/matching";
import { emptyProfile, profileSchema, type Field, type Profile } from "../src/shared/model";

// The matcher (src/shared/matching.ts) on many random forms: labels real and
// meaningless, every kind of field, lists or none, some already answered or
// protected. Whatever the form, what it proposes keeps to a few rules. Seeded,
// so a failure names the run that shows it.

let state = 7;
const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
const labels = [
  "First Name", "Last Name", "Name", "Preferred name", "Email", "Phone", "Address", "City", "State", "Country", "Zip",
  "LinkedIn", "Website", "Are you legally authorized to work in the United States?", "Will you require sponsorship?",
  "Gender", "Race", "Veteran status", "Disability", "Pronouns", "Salary expectations", "Date of birth",
  "Social Security Number", "SSN", "Password", "Confirm password", "Credit card number",
  "School", "Degree", "Major", "GPA", "Start date", "End date", "Employer", "Job title", "Years of experience",
  "How did you hear about us?", "Why do you want to work here?", "Today's Date", "Signature", "I agree to the terms",
  "Unlabelled field", "", "xq zzv",
];
const kinds = ["text", "textarea", "select", "radio", "checkbox", "email", "tel", "password", "file", "date", "combobox", "url", "number"];
const lists = [[], ["Yes", "No"], ["Male", "Female", "Decline to self-identify"], ["United States", "Canada"], ["LinkedIn", "Indeed", "Other"], ["1", "2", "3+"]];
const field = (i: number): Field =>
  ({
    id: `f${i}`,
    label: pick(labels) + (random() < 0.2 ? " *" : ""),
    kind: pick(kinds),
    value: random() < 0.15 ? "existing" : "",
    required: random() < 0.5,
    options: pick(lists),
    revision: 1,
    protected: random() < 0.15,
    ...(random() < 0.3 ? { section: pick(["Education", "Work Experience", "Personal"]), index: Math.floor(random() * 2) } : {}),
  }) as Field;

const applicant = profileSchema.parse({
  confirmed: true, revision: 1, firstName: "Alex", lastName: "Rivera", email: "alex@example.test", phone: "(555) 010-0199",
  city: "Phoenix", state: "Arizona", country: "United States", postalCode: "85001", linkedin: "https://linkedin.com/in/alex",
  facts: [{ id: "a", text: "Built TypeScript tools." }],
  education: [{ organization: "Pennsylvania State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-08", endDate: "2024-05", location: "", details: "" }],
  work: [{ organization: "Contoso", title: "Engineer", startDate: "2024-06", endDate: "", location: "", details: "" }],
});
const nobody = { ...emptyProfile, confirmed: true } as Profile;
const own = /alex|rivera|phoenix|85001|555|contoso|pennsylvania state/i;

test("on random forms the matcher never throws, and proposes only what it may", () => {
  for (let run = 0; run < 1500; run++) {
    const fields = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, i) => field(i));
    for (const profile of [applicant, nobody]) {
      const out = proposals(fields, profile);
      const where = `run ${run}`;
      // The same form, the same proposals.
      assert.equal(JSON.stringify(proposals(fields, profile)), JSON.stringify(out), where);
      const ids = out.map((proposal) => proposal.fieldId);
      assert.equal(new Set(ids).size, ids.length, `${where}: one proposal per field`);
      for (const proposal of out) {
        const target = fields.find((candidate) => candidate.id === proposal.fieldId);
        assert.ok(target, `${where}: a proposal for a field it was not given`);
        assert.equal(target!.protected, false, `${where}: a protected field (${target!.label})`);
        assert.notEqual(target!.kind, "password", `${where}: a password field`);
        assert.doesNotMatch(target!.label, /ssn|social security|credit card|password/i, `${where}: ${target!.label}`);
        // A value already there is kept (a URL missing its scheme is the one repair).
        if (target!.value) assert.equal(target!.kind, "url", `${where}: wrote over ${target!.label}`);
        // With nothing saved, nothing of anyone's is proposed.
        if (profile === nobody) assert.doesNotMatch(proposal.value, own, where);
      }
    }
  }
});
