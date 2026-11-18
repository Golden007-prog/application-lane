import assert from "node:assert/strict";
import { test } from "node:test";
import { siteRuleProblems } from "../src/shared/model";

// The card lists a site rule's failed step only when it found its field and
// still failed: not a field absent from this form, a value the profile does
// not hold, a question the rule declined, or a field the applicant edited.
test("only site-rule failures worth checking reach the card", () => {
  const notes = [
    "first_name: No configured selector matched.",
    "phone: No confirmed profile value.",
    "education: Repeated section requires a profile row.",
    "city: Field is locked by a trusted user edit.",
    "sponsorship: This question asks whether the applicant can work without sponsorship.",
    "last_name: The site did not keep the value it was given.",
    "degree: The site's list has no option for \"Master of Science\".",
    "education[1].school: Site did not accept the configured value.",
    "upload resume: The upload control did not take the file.",
    "Replaced the Resume the site already had with this application's tailored one.",
  ];
  assert.deepEqual(siteRuleProblems(notes), [
    "last_name: The site did not keep the value it was given.",
    "degree: The site's list has no option for \"Master of Science\".",
    "education[1].school: Site did not accept the configured value.",
    "upload resume: The upload control did not take the file.",
  ]);
  assert.deepEqual(siteRuleProblems(undefined), []);
});
