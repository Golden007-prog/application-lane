import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { controlKind } from "../src/engine/page/click-gate";
import { globalConfigSchema, siteConfigSchema } from "../src/engine/config/schema";
import { emptyProfile } from "../src/shared/model";

let browser: Browser;
let page: Page;
let gate: string;
let engine: string;
let mainWorld: string;
const globals = globalConfigSchema.parse(JSON.parse(await readFile("src/engine/config/globals.json", "utf8")));
const lever = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/lever.json", "utf8")));
const tesla = siteConfigSchema.parse(JSON.parse(await readFile("src/engine/config/sites/tesla.json", "utf8")));

// tsx names the functions it passes to the page with __name.
const bundle = async (entry: string, name: string) =>
  "window.__name = (fn) => fn;\n" +
  (await build({ bundle: true, entryPoints: [entry], format: "iife", globalName: name, platform: "browser", write: false }))
    .outputFiles[0].text;
const applicant = { ...emptyProfile, firstName: "Alex", lastName: "Rivera" };

before(async () => {
  gate = await bundle("tests/support/gate-entry.ts", "Gate");
  engine = await bundle("src/engine/config/interpreter.ts", "ConfigEngine");
  mainWorld = await bundle("src/engine/page/mainWorld.ts", "MainWorld");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

test("controls a fill must not press are named by their labels", () => {
  const kinds: [string, string][] = [
    ["Submit application", "submit"],
    ["Apply now", "submit"],
    ["Finish", "submit"],
    ["I agree", "signature"],
    ["Sign and continue", "signature"],
    ["Next", "navigation"],
    ["Continue", "navigation"],
    ["Save and Continue", "navigation"],
    ["Save & Next", "navigation"],
    ["Review application", "navigation"],
    ["Proceed", "navigation"],
    // A calendar's or a list's own buttons, and answers, are not steps.
    ["Next month", "other"],
    ["Next page", "other"],
    ["I can start within the next two weeks", "other"],
    ["Add another", "other"],
    ["Upload resume", "other"],
    ["Yes", "other"],
    ["Save", "other"],
    ["", "other"],
  ];
  for (const [label, kind] of kinds) assert.equal(controlKind(label), kind, label);
});

test("a click inside a Next, Submit or signing control is refused; a list's option is not", async () => {
  await page.setContent(`
    <div role="listbox"><div role="option" id="option">Arizona</div></div>
    <button type="button" id="next"><span id="inside-next">Next</span></button>
    <a href="#" id="continue">Save and Continue</a>
    <button type="button" id="month">Next month</button>
    <button type="button" id="sign">I agree</button>
    <input type="submit" id="send" value="Go">
  `);
  await page.addScriptTag({ content: gate });
  const pressed = await page.evaluate(() => {
    const kind = (id: string) => (window as any).Gate.pressedControl(document.getElementById(id))?.kind ?? "none";
    return Object.fromEntries(["option", "inside-next", "continue", "month", "sign", "send"].map((id) => [id, kind(id)]));
  });
  assert.deepEqual(pressed, {
    option: "none",
    "inside-next": "navigation",
    continue: "navigation",
    month: "none",
    sign: "signature",
    send: "submit",
  });
  const clicked = await page.evaluate(() => {
    let presses = 0;
    document.getElementById("next")!.addEventListener("click", () => presses++);
    let refused = "";
    try {
      (window as any).Gate.fillClick(document.getElementById("inside-next"));
    } catch (error) {
      refused = (error as Error).message;
    }
    return { presses, refused };
  });
  assert.equal(clicked.presses, 0);
  assert.match(clicked.refused, /Next or Continue/);
});

test("a real click is sent only where it lands on no step, submit or signing control", async () => {
  await page.setContent(`
    <style>body { margin: 0 } button, div { display: block; width: 200px; height: 40px; margin: 0 }</style>
    <div role="option" id="option">Arizona</div>
    <button type="button" id="next">Next</button>
    <form><button id="implicit">Choose</button></form>
  `);
  await page.addScriptTag({ content: gate });
  const allowed = await page.evaluate(() => {
    const at = (id: string) => {
      const box = document.getElementById(id)!.getBoundingClientRect();
      return (window as any).Gate.clickPointAllowed({ x: box.left + 10, y: box.top + 10 });
    };
    return { option: at("option"), next: at("next"), implicit: at("implicit"), nowhere: (window as any).Gate.clickPointAllowed({ x: 5000, y: 5000 }) };
  });
  assert.deepEqual(allowed, { option: true, next: false, implicit: false, nowhere: false });
});

test("Enter is pressed only in a list's own box, or outside a form", async () => {
  await page.setContent(`
    <form>
      <input id="plain">
      <input id="combo" role="combobox" aria-expanded="true">
      <button type="button" id="next">Next</button>
    </form>
    <input id="loose">
  `);
  await page.addScriptTag({ content: gate });
  const allowed = await page.evaluate(() =>
    Object.fromEntries(["plain", "combo", "next", "loose"].map((id) => [id, (window as any).Gate.enterAllowed(document.getElementById(id))])),
  );
  assert.deepEqual(allowed, { plain: false, combo: true, next: false, loose: true });
});

test("the page-world executor refuses the same Next and Continue controls", async () => {
  await page.setContent(`
    <button type="button" id="next">Continue</button>
    <button type="button" id="month">Next month</button>
  `);
  await page.addScriptTag({ content: mainWorld });
  const results = await page.evaluate(() => {
    const press = (id: string) => {
      const element = document.getElementById(id)!;
      const token = id === "next" ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666";
      element.setAttribute("data-application-lane-main", token);
      return (window as any).MainWorld.applyMainWorld({ method: "click", token, values: [] });
    };
    return { next: press("next"), month: press("month") };
  });
  assert.equal(results.next.ok, false);
  assert.match(results.next.reason, /Refused/);
  assert.equal(results.month.ok, true);
});

test("a site rule's click on a Next button is refused", async () => {
  await page.setContent(`<form><button type="button" id="next">Next</button></form>`);
  await page.addScriptTag({ content: engine });
  const result = await page.evaluate(async ({ globals, applicant }) => {
    let presses = 0;
    document.getElementById("next")!.addEventListener("click", () => presses++);
    const config = {
      ats: "Example", urls: ["*://jobs.example.test/*"], urlsExcluded: [], embeddedPaths: [], pathsExcluded: [],
      containerPath: [], containerRequired: false, defaultMethod: "default", submitButtonPaths: [],
      submittedSuccessPaths: [], trackedInputSelectors: [],
      inputSelectors: [["first_name", [{ path: ["//button[@id='next']"], method: "click" }]]],
    };
    const statuses = await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.example.test/apply", config, globals, applicant);
    return { presses, statuses };
  }, { globals, applicant });
  assert.equal(result.presses, 0);
  assert.equal(result.statuses[0].status, "failed");
  assert.match(result.statuses[0].reason, /Next or Continue/);
});

test("signature fields are told apart from ordinary ones", async () => {
  await page.setContent(`
    <form>
      <label>Full name<input id="full" name="name"></label>
      <label>Have you signed a non-compete?<input type="radio" id="question" name="noncompete"></label>
      <h4>Voluntary Self-Identification of Disability</h4>
      <div><label>Name<input id="lever-name" name="eeo[disabilitySignature]"></label>
      <label>Date<input id="lever-date" name="eeo[disabilitySignatureDate]"></label></div>
      <input id="tesla-legal" name="legal.legalAcknowledgmentName">
      <input id="tesla-eeo" name="eeo.eeoDisabilityStatusName">
      <div><div data-automation-id="formField-name"><label for="selfIdentifiedDisabilityData--name">Name</label>
        <input id="selfIdentifiedDisabilityData--name"></div></div>
      <section>
        <div data-automation-id="formField-name"><label for="workday-name">Name</label><input id="workday-name"></div>
        <div data-automation-id="formField-dateSignedOn"><input id="workday-month" role="spinbutton" aria-label="Month"></div>
      </section>
      <label>Signature<input id="attest"></label>
    </form>
  `);
  await page.addScriptTag({ content: gate });
  const kinds = await page.evaluate(() =>
    Object.fromEntries(
      ["full", "question", "lever-name", "lever-date", "tesla-legal", "tesla-eeo", "selfIdentifiedDisabilityData--name", "workday-name", "workday-month", "attest"].map(
        (id) => [id, (window as any).Gate.signatureField(document.getElementById(id)) ?? "none"],
      ),
    ),
  );
  assert.deepEqual(kinds, {
    full: "none",
    question: "none",
    "lever-name": "self-id",
    "lever-date": "self-id",
    "tesla-legal": "attestation",
    "tesla-eeo": "self-id",
    "selfIdentifiedDisabilityData--name": "self-id",
    "workday-name": "attestation",
    "workday-month": "attestation",
    attest: "attestation",
  });
});

const leverForm = `
  <form>
    <label>Full name<input name="name"></label>
    <h4>Voluntary Self-Identification of Disability</h4>
    <div><label>Name<input name="eeo[disabilitySignature]"></label>
    <label>Date<input name="eeo[disabilitySignatureDate]"></label></div>
  </form>`;

for (const [policy, signed] of [[undefined, false], ["never", false], ["self-id", true], ["all", true]] as const)
  test(`Lever's disability signature is ${signed ? "signed" : "left"} when signatures are ${policy ?? "unset"}`, async () => {
    await page.setContent(leverForm);
    await page.addScriptTag({ content: engine });
    const result = await page.evaluate(
      async ({ config, globals, policy, applicant }: any) => {
        const statuses = await (window as any).ConfigEngine.interpretConfig(document, "https://jobs.lever.co/acme/123/apply", config, globals, {
          ...applicant,
          signatures: policy,
        });
        return {
          name: (document.querySelector('[name="name"]') as HTMLInputElement).value,
          signature: (document.querySelector('[name="eeo[disabilitySignature]"]') as HTMLInputElement).value,
          date: (document.querySelector('[name="eeo[disabilitySignatureDate]"]') as HTMLInputElement).value,
          reasons: statuses.filter((status: any) => status.status === "skipped").map((status: any) => status.reason),
        };
      },
      { config: lever, globals, policy, applicant } as unknown as Record<string, unknown>,
    );
    assert.equal(result.name, "Alex Rivera");
    if (signed) {
      assert.equal(result.signature, "Alex Rivera");
      assert.match(result.date, /^\d\d\/\d\d\/\d{4}$/);
    } else {
      assert.equal(result.signature, "");
      assert.equal(result.date, "");
      assert.ok(result.reasons.some((reason: string) => /self-identification form is left for you/.test(reason)));
    }
  });

test("Tesla's legal acknowledgment is signed only when every signature is allowed", async () => {
  const form = `<form><input name="legal.legalAcknowledgmentName"></form>`;
  const run = async (policy: string) => {
    await page.setContent(form);
    await page.addScriptTag({ content: engine });
    return page.evaluate(
      async ({ config, globals, policy, applicant }: any) => {
        await (window as any).ConfigEngine.interpretConfig(document, "https://www.tesla.com/careers/search/job/apply/123", config, globals, {
          ...applicant,
          signatures: policy,
        });
        return (document.querySelector('[name="legal.legalAcknowledgmentName"]') as HTMLInputElement).value;
      },
      { config: tesla, globals, policy, applicant } as unknown as Record<string, unknown>,
    );
  };
  assert.equal(await run("self-id"), "");
  assert.equal(await run("all"), "Alex Rivera");
});
