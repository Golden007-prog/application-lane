import assert from "node:assert/strict";
import { test } from "node:test";
import { rowHolds } from "../src/extension/row-holds";
import { profileSchema, type Field } from "../src/shared/model";

const profile = profileSchema.parse({
  confirmed: true,
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  facts: [],
  work: [],
  education: [
    { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08-19", endDate: "2099-05-10", location: "", details: "" },
    { organization: "Pennsylvania State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15", location: "", details: "" },
  ],
});
const field = (label: string, value: string, index: number, extra: Partial<Field> = {}): Field => ({
  id: `${label}-${index}`, label, kind: "select", value, required: false, options: [], revision: 1, protected: false,
  section: "Education", index, siteValue: true, ...extra,
});

// one employer's iCIMS: filled again with every row already right, the
// rows were skipped whole and the review flagged what the site held: a
// list's coded value ("28595" for "In Progress") and a date's day.
test("a school row's graduation status and date day are read as the profile's", () => {
  // The site lists the bachelor's first, as one employer's iCIMS redrew it.
  const rows = [
    field("School", "Pennsylvania State University", 0, { kind: "combobox" }),
    field("Did You Graduate?", "28598", 0, { valueText: "Received" }),
    field("Date Received / Date Expected to Receive Day", "15", 0),
    field("Date Received / Date Expected to Receive Month", "06", 0, { valueText: "Jun" }),
    field("School", "Michigan State University", 1, { kind: "combobox" }),
    field("Did You Graduate?", "28595", 1, { valueText: "In Progress" }),
    field("Date Received / Date Expected to Receive Day", "10", 1),
  ];
  for (const one of rows.filter((entry) => entry.label !== "School"))
    assert.equal(rowHolds(one, rows, profile), true, `${one.label} ${one.value}`);
  // Wrong ones are still flagged.
  const wrong = [
    field("School", "Michigan State University", 0, { kind: "combobox" }),
    field("Did You Graduate?", "28598", 0, { valueText: "Received" }),
    field("Date Received / Date Expected to Receive Day", "15", 0),
  ];
  assert.equal(rowHolds(wrong[1], wrong, profile), false);
  assert.equal(rowHolds(wrong[2], wrong, profile), false);
});

// one employer's iCIMS: the bachelor's row's "not listed" box held the
// master's school. The row is the bachelor's, by its own School field, and
// the box is flagged.
test("a row is known by its own school, not by a school typed in its 'not listed' box", () => {
  const row = [
    field("School", "Pennsylvania State University", 0, { kind: "combobox" }),
    field("If your school is not listed, enter it here", "Michigan State University", 0, { kind: "text" }),
    field("Did You Graduate?", "28598", 0, { valueText: "Received" }),
  ];
  assert.equal(rowHolds(row[1], row, profile), false);
  assert.equal(rowHolds(row[2], row, profile), true);
});

// A job marked current with an expected end date: the site rules tick "I
// currently work here" for it, and the general fill's check agrees (it used
// to read only the missing end date, and flagged the site's tick).
test("the current-job box is read by one rule: the row's own mark, else no end date", async () => {
  const { currentRow } = await import("../src/engine/values");
  assert.equal(currentRow({ current: true, endDate: "2027-06" }), true);
  assert.equal(currentRow({ current: false, endDate: "" }), false);
  assert.equal(currentRow({ endDate: "" }), true);
  assert.equal(currentRow({ endDate: "2024-06" }), false);
  const working = profileSchema.parse({
    ...profile,
    education: [],
    work: [{ organization: "Contoso Analytics", title: "Data Analyst", startDate: "2024-01", endDate: "2027-06", current: true, location: "", details: "" }],
  });
  const box = (value: string) => ({ id: "current", label: "I currently work here", kind: "checkbox", value, required: false, options: [], revision: 1, protected: false, section: "Work Experience", index: 0, siteValue: true }) as Field;
  const employer = { ...box(""), id: "employer", label: "Company", kind: "text", value: "Contoso Analytics" } as Field;
  assert.equal(rowHolds(box("yes"), [box("yes"), employer], working), true);
  assert.equal(rowHolds(box("no"), [box("no"), employer], working), false);
});
