import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { siteConfigSchema } from "../src/engine/config/schema";

// Every click a site's rules can make, read from the rules themselves: none
// may aim at a control that submits, moves to the next step, signs or
// consents. The click gate (src/engine/page/click-gate.ts) refuses those at
// run time by what the control says; this catches a rule written to press
// one before it ever runs. A rule that names such a word for another reason
// is listed here with the reason.
const allowed: Record<string, string> = {
  "paylocity.json //*[@data-automation-id='btnPublicApply']//a":
    "the posting's own Apply button, which opens the form: asking for a fill is asking to apply",
  "smartrecruiters.json .//*[@data-test='experience-save']": "saves one job of the experience list, not the application",
  "smartrecruiters.json .//*[@data-test='education-save']": "saves one school of the education list, not the application",
  "workable.json .//button[@data-ui='save-section']": "saves one entry of a repeating section, not the application",
  "oracle.json graduated_flag": "'apply-flow' is the form's class name; the click ticks the Graduated box",
};
const risky = /submit|\bnext\b|continue|\bsign|agree|consent|accept|proceed|finish|review|apply|save/i;

type Click = { site: string; key: string; text: string };
function clicks(site: string, value: unknown, found: Click[] = []): Click[] {
  if (Array.isArray(value)) for (const item of value) clicks(site, item, found);
  else if (value && typeof value === "object") {
    const rule = value as Record<string, unknown>;
    if (/click/i.test(String(rule.method || ""))) {
      const path = Array.isArray(rule.path) ? rule.path.join(" ") : String(rule.path || "");
      found.push({ site, key: `${site} ${path || String(rule.valueKey || "")}`, text: JSON.stringify(rule) });
    }
    for (const child of Object.values(rule)) clicks(site, child, found);
  }
  return found;
}

const sites = readdirSync("src/engine/config/sites").filter((name) => name.endsWith(".json"));
const all = sites.flatMap((site) => {
  const config = JSON.parse(readFileSync(`src/engine/config/sites/${site}`, "utf8"));
  siteConfigSchema.parse(config);
  return clicks(site, config);
});

test("no site rule clicks a control that submits, moves on, signs or consents", () => {
  assert.ok(all.length > 100, `only ${all.length} click rules found: did the rules' shape change?`);
  const unexplained = all.filter((click) => risky.test(click.text) && !allowed[click.key]).map((click) => click.key);
  assert.deepEqual(unexplained, [], "click rules naming a submit, next, sign or consent word; if one is safe, add it to `allowed` with the reason");
});

test("every allowed click rule still exists", () => {
  const keys = new Set(all.map((click) => click.key));
  assert.deepEqual(Object.keys(allowed).filter((key) => !keys.has(key)), []);
});
