import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";

// A honeypot is a field a person never sees, there to catch a bot that fills
// everything: moved off the page, or labelled "leave this blank". A filled
// one can mark the application as spam, so it is not a field to fill.
// Custom checkboxes, radios and file inputs are hidden on purpose behind
// their drawn controls, and are filled as before.

let browser: Browser;
let page: Page;
let fields: string;

before(async () => {
  // tsx names the functions it passes to the page with __name.
  fields = "window.__name = (fn) => fn;\n" +
    (await build({ bundle: true, entryPoints: ["tests/support/fields-entry.ts"], format: "iife", globalName: "Fields", platform: "browser", write: false }))
      .outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

const read = async (html: string) => {
  await page.setContent(`<form>${html}</form>`);
  await page.addScriptTag({ content: fields });
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-case]")].map((element) => [element.dataset.case, (window as any).Fields.writable(element)]),
    ),
  );
};

test("honeypots are not fields to fill", async () => {
  const result = await read(`
    <div style="position:absolute;left:-9999px"><label>Website <input data-case="moved off the page" name="website"></label></div>
    <input data-case="above the page" name="url" style="position:absolute;top:-5000px">
    <label>Leave this field blank <input data-case="leave blank" name="contact_me"></label>
    <label for="h">If you are human, do not fill this in</label><input id="h" data-case="if human">
    <input data-case="named bot-field" name="bot-field" aria-label="Don't fill this out">
    <input data-case="formspree" name="_gotcha" aria-label="Gotcha">
    <textarea data-case="honeypot class" class="form-honeypot" aria-label="Comments"></textarea>
  `);
  for (const [name, fillable] of Object.entries(result)) assert.equal(fillable, false, name);
});

test("ordinary and deliberately hidden controls are still fields", async () => {
  const result = await read(`
    <label>First name <input data-case="text box" name="first"></label>
    <label>Website <input data-case="website" name="website" type="url"></label>
    <label>Notes <textarea data-case="notes"></textarea></label>
    <label style="position:relative"><input data-case="custom checkbox" type="checkbox" style="position:absolute;left:-9999px"> I have a license</label>
    <label><input data-case="custom radio" type="radio" name="r" style="opacity:0;position:absolute"> Yes</label>
    <label>Please leave a comment <input data-case="leave a comment"></label>
    <label>Phone (leave blank if none) <input data-case="leave blank if none" type="tel"></label>
  `);
  for (const [name, fillable] of Object.entries(result)) assert.equal(fillable, true, name);
});
