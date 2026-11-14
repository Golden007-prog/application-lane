import assert from "node:assert/strict";
import { test } from "node:test";
import { addedLines, collectTerms, dataDirectory, findLeaks } from "../scripts/leak-check.mjs";

const profile = {
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex.rivera@example.com",
  phone: "(540) 555-0142",
  address: "100 Main Street",
  postalCode: "24060",
  city: "Blacksburg",
  linkedin: "https://www.linkedin.com/in/alex-rivera-example/",
  work: [{ organization: "Northwind Labs" }],
  education: [{ organization: "Virginia Tech" }, { organization: "Penn State University" }],
  references: [{ name: "Jordan Lee", email: "jordan@example.org", phone: "540-555-0199" }],
};
const applications = [
  { company: "Contoso Pharmaceuticals", url: "https://contoso.wd1.myworkdayjobs.com/en-US/careers/job/1" },
  { company: "Atlas", url: "https://job-boards.greenhouse.io/atlas/jobs/1" },
  { company: "esb", url: "https://esb.wd12.myworkdayjobs.com/x" },
  { company: "ats", url: "https://ats.rippling.com/acme/jobs/1" },
];
const lines = (...texts: string[]) => texts.map((line, index) => ({ where: `a.ts:${index + 1}`, line }));
const found = (texts: string[], terms = collectTerms({ profile, applications })) => findLeaks(lines(...texts), terms).map(({ where, term }) => `${where} ${term}`);
// Each line's terms, as a set: a line can hold several (a name inside an email).
const termsByLine = (texts: string[], terms?: ReturnType<typeof collectTerms>) => {
  const byLine: string[][] = texts.map(() => []);
  for (const hit of found(texts, terms)) {
    const [, line, term] = /^a\.ts:(\d+) (.*)$/.exec(hit)!;
    byLine[Number(line) - 1].push(term);
  }
  return byLine;
};

test("the leak check finds the profile's names, contact details, address, schools, employers and references", () => {
  const byLine = termsByLine([
      "// Alex's form",
      "const email = 'alex.rivera@example.com';",
      "call 540.555.0142 or +1 540 555 0142",
      "at 100 Main Street, Blacksburg 24060",
      "linkedin.com/in/alex-rivera-example",
      "a Virginia Tech degree; PSU too",
      "worked at Northwind Labs",
      "ask Jordan Lee",
  ]);
  const expected = [
    ["Alex"],
    ["alex.rivera@example.com", "alex.rivera"],
    ["5405550142"],
    ["100 Main Street", "24060", "Blacksburg"],
    ["linkedin.com/in/alex-rivera-example", "alex-rivera-example"],
    ["Virginia Tech", "PSU"],
    ["Northwind Labs"],
    ["Jordan Lee"],
  ];
  expected.forEach((terms, index) => terms.forEach((term) => assert.ok(byLine[index].includes(term), `line ${index + 1} lacks ${term}: ${byLine[index]}`)));
});

test("the leak check finds companies applied to, by name and by their job-site address", () => {
  assert.deepEqual(found(["Contoso Pharmaceuticals asks", "https://contoso.wd1.myworkdayjobs.com/x", "Atlas's form", "ESB's Workday"]), [
    "a.ts:1 Contoso Pharmaceuticals",
    "a.ts:1 contoso",
    "a.ts:2 contoso",
    "a.ts:3 Atlas",
    "a.ts:4 esb",
  ]);
});

test("the leak check leaves everyday words, job-site vendors and parts of other words alone", () => {
  assert.deepEqual(
    found([
      "import { x } from '../src/atlas/page';",
      "npx esb build",
      "https://ats.rippling.com/other/jobs/2",
      "a Workday or Greenhouse form",
      "Alexander and Riverside",
      "order 954055501421",
      "PSUs are psu",
    ]),
    // A longer digit run is not the phone number; neither is a word that merely contains a name.
    [],
  );
});

test("the leak check's allow list and extra terms come from the data folder", () => {
  const terms = collectTerms({ profile, applications, extra: ["Fabrikam"], allow: ["Atlas", "Blacksburg"] });
  assert.deepEqual(found(["Atlas's form in Blacksburg", "at Fabrikam"], terms), ["a.ts:2 Fabrikam"]);
});

test("the leak check reads the added lines of a diff with their file and line, and new paths", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,3 @@ context",
    " kept",
    "-gone",
    "+added one",
    "+added two",
    "--- /dev/null",
    "+++ b/docs/new.md",
    "@@ -0,0 +1 @@",
    "+new file",
  ].join("\n");
  assert.deepEqual(addedLines(diff), [
    { where: "src/a.ts (its path)", line: "src/a.ts" },
    { where: "src/a.ts:11", line: "added one" },
    { where: "src/a.ts:12", line: "added two" },
    { where: "docs/new.md (its path)", line: "docs/new.md" },
    { where: "docs/new.md:1", line: "new file" },
  ]);
});

test("the leak check finds the data folder as the backend does", () => {
  assert.equal(dataDirectory({ LANE_DATA_DIR: "data" }, "/work"), "/work/data");
  assert.equal(dataDirectory({}, "/nowhere", "linux", "/home/alex", "/nowhere"), "/home/alex/.local/share/application-lane");
  assert.equal(dataDirectory({ XDG_DATA_HOME: "/xdg" }, "/nowhere", "linux", "/home/alex", "/nowhere"), "/xdg/application-lane");
});
