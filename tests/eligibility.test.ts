import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { globalConfigSchema } from "../src/engine/config/schema";
import { emptyProfile } from "../src/shared/model";
import { reviewFirstQuestion } from "../src/shared/questions";

let browser: Browser;
let page: Page;
let engine: string;
const globals = globalConfigSchema.parse(JSON.parse(await readFile("src/engine/config/globals.json", "utf8")));
// A U.S. citizen applying to a U.S. job.
const applicant = {
  ...emptyProfile,
  firstName: "Alex",
  lastName: "Rivera",
  workAuthorization: [{ country: "US", status: "citizen" }],
  applyingTo: { country: "United States" },
};

before(async () => {
  // tsx names the functions it passes to the page with __name.
  engine = "window.__name = (fn) => fn;\n" +
    (await build({ bundle: true, entryPoints: ["src/engine/config/interpreter.ts"], format: "iife", globalName: "ConfigEngine", platform: "browser", write: false }))
      .outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

// One site rule for the work-authorization answer, reaching the select at
// `path`, or (when it reaches nothing) the select its label names.
const authorize = async (markup: string, path: string) => {
  await page.setContent(`<form>${markup}</form>`);
  await page.addScriptTag({ content: engine });
  return page.evaluate(
    async ({ globals, applicant, path }: any) => {
      const config = {
        ats: "Example", urls: ["*://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
        containerPath: [], containerRequired: false, defaultMethod: "default", submitButtonPaths: [],
        submittedSuccessPaths: [], trackedInputSelectors: [],
        inputSelectors: [["work_auth", [path]]],
      };
      const statuses = await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, applicant);
      return { value: (document.querySelector("select") as HTMLSelectElement).value, status: statuses[0] };
    },
    { globals, applicant, path } as unknown as Record<string, unknown>,
  );
};
const yesNo = `<option value=""></option><option>Yes</option><option>No</option>`;

test("a work-authorization rule answers for the job's own country only", async () => {
  const us = await authorize(`<label for="q">Are you legally authorized to work in the United States?</label><select id="q">${yesNo}</select>`, "//select[@id='q']");
  assert.equal(us.value, "Yes");
  // On a U.S. job, the U.K.'s question has its own answer, which the
  // profile does not hold.
  const uk = await authorize(`<label for="q">Are you legally authorized to work in the United Kingdom?</label><select id="q">${yesNo}</select>`, "//select[@id='q']");
  assert.equal(uk.value, "");
  assert.equal(uk.status.status, "skipped");
  assert.match(uk.status.reason, /another country/);
});

test("a question that authorizes something else is not a work-authorization question", async () => {
  // The rule's own path reaches nothing: the select is found by its label.
  const background = await authorize(`<label for="q">Do you authorize a background check?</label><select id="q">${yesNo}</select>`, "//select[@id='missing']");
  assert.equal(background.value, "");
  const work = await authorize(`<label for="q">Are you authorized to work in the United States?</label><select id="q">${yesNo}</select>`, "//select[@id='missing']");
  assert.equal(work.value, "Yes");
});

test("a list worded in sentences gets a bare Yes only for one that adds no claim", async () => {
  const options = `<option value=""></option><option>Yes, I am a U.S. citizen</option><option>No</option>`;
  const citizen = await authorize(`<label for="q">Are you legally authorized to work in the United States?</label><select id="q">${options}</select>`, "//select[@id='q']");
  assert.equal(citizen.value, "");
  const restated = `<option value=""></option><option>Yes, I am authorized to work in the United States</option><option>No</option>`;
  const plain = await authorize(`<label for="q">Are you legally authorized to work in the United States?</label><select id="q">${restated}</select>`, "//select[@id='q']");
  assert.equal(plain.value, "Yes, I am authorized to work in the United States");
});

test("questions about identity, eligibility and pay wait for the applicant even in automatic AI filling", () => {
  for (const question of [
    "Gender",
    "Race/Ethnicity",
    "Are you Hispanic or Latino?",
    "Disability status",
    "Protected veteran status",
    "Are you legally authorized to work in the United States?",
    "Will you require visa sponsorship?",
    "What are your salary expectations?",
    "Desired hourly pay rate",
  ])
    assert.equal(reviewFirstQuestion(question), true, question);
  // Legal questions follow their own setting (legalQuestion).
  for (const question of ["Preferred first name", "Years of experience with Python", "How did you hear about us?", "LinkedIn profile", "Have you ever been convicted of a felony?"])
    assert.equal(reviewFirstQuestion(question), false, question);
});
