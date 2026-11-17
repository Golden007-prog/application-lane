import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";

let browser: Browser;
let page: Page;
let gate: string;

before(async () => {
  // tsx names the functions it passes to the page with __name.
  gate = "window.__name = (fn) => fn;\n" +
    (await build({ bundle: true, entryPoints: ["tests/support/gate-entry.ts"], format: "iife", globalName: "Gate", platform: "browser", write: false }))
      .outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

const found = () =>
  page.evaluate(() => {
    const controls = (window as any).Gate.stepControls(document);
    const label = (element: Element) => (window as any).Gate.stepLabel(element);
    return { next: controls.next.map(label), submit: controls.submit.map(label) };
  });

test("a step's Next and Submit are found by their exact wording only", async () => {
  await page.setContent(`
    <form>
      <button type="button">Next month</button>
      <button type="button">Agree and continue</button>
      <button type="button">Save and finish later</button>
      <button type="button">Send code</button>
      <button type="button">Review and submit</button>
      <button type="button" disabled>Continue</button>
      <button type="button" hidden>Submit</button>
      <a href="#"><span>Save and Continue →</span></a>
      <input type="submit" value="Submit Application">
    </form>
  `);
  await page.addScriptTag({ content: gate });
  assert.deepEqual(await found(), { next: ["Save and Continue"], submit: ["Submit Application"] });
});

test("two Next buttons are both reported, so neither is pressed for the applicant", async () => {
  await page.setContent(`<button type="button">Next</button><div role="button">Continue</div>`);
  await page.addScriptTag({ content: gate });
  assert.deepEqual((await found()).next, ["Next", "Continue"]);
});

test("a step control is pressed only while it still says what was confirmed", async () => {
  await page.setContent(`<button type="button" id="next">Next</button>`);
  await page.addScriptTag({ content: gate });
  const result = await page.evaluate(() => {
    let presses = 0;
    const button = document.getElementById("next")!;
    button.addEventListener("click", () => presses++);
    const press = (kind: string, label: string) => {
      try {
        (window as any).Gate.pressStep(button, kind, label);
        return "pressed";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const wrongKind = press("submit", "Next");
    const wrongLabel = press("next", "Continue");
    const right = press("next", "Next");
    return { wrongKind, wrongLabel, right, presses };
  });
  assert.match(result.wrongKind, /no longer says/);
  assert.match(result.wrongLabel, /now says "Next"/);
  assert.equal(result.right, "pressed");
  assert.equal(result.presses, 1);
});
