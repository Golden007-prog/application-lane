import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

// Site rules find controls by names a site keeps: ids, names, data-*
// attributes, labels, and the form's own class names (Oracle's
// "apply-flow-section"). A class name a build tool generates ("css-1x2y3z",
// "sc-bdVaJa", "jss12", "Button_root__a1B2c") changes with the site's next
// deploy, and a rule built on one stops matching without a sound.

// A class a CSS-in-JS library or CSS modules made, not the site's author.
export const generatedClass = /\b(?:css-[a-z0-9]{5,}|sc-[a-zA-Z]{5,}|jss\d+|makeStyles-[\w-]+|[A-Z]\w*_\w+__[A-Za-z0-9]{5}|e[a-z0-9]{6,}\d)\b/;

function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, found);
  return found;
}

test("no site rule depends on a class name a build tool generated", () => {
  const found: string[] = [];
  for (const site of readdirSync("src/engine/config/sites").filter((name) => name.endsWith(".json")))
    for (const text of strings(JSON.parse(readFileSync(`src/engine/config/sites/${site}`, "utf8"))))
      for (const match of text.matchAll(/@class[^\]]*/g))
        if (generatedClass.test(match[0])) found.push(`${site}: ${text.slice(0, 120)}`);
  assert.deepEqual(found, [], "find these controls by an id, name, data-* attribute or label instead");
});

test("generated class names are told from a site's own", () => {
  for (const generated of ["css-1x2y3zq", "sc-bdVaJa", "jss12", "makeStyles-root-3", "Button_root__a1B2c"])
    assert.ok(generatedClass.test(`contains(@class,'${generated}')`), generated);
  for (const own of ["apply-flow-section", "datasetField", "ashby-application-form-container", "eform_field_label", "work-history-group", "select2-selection"])
    assert.ok(!generatedClass.test(`contains(@class,'${own}')`), own);
});
