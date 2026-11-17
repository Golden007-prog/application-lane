import assert from "node:assert/strict";
import { test } from "node:test";
import { foundInProfile } from "../src/server/generation";

// How the drafting step reads the profile when it overrules the checking
// model (generation.ts): the tailoring folder's profile.md and preferences,
// then the confirmed facts.
const profile = `## Experience

### Course Search, 2025
- Built a course search service with FastAPI and Postgres for 400 students.

### Lab Dashboard
- Built a dashboard in React that charts sensor readings.

## Skills inventory
- Languages: Python, TypeScript, Go
- Tools: Docker, Kubernetes

## Known gaps
- No Redis in production yet.

## Confirmed facts
- Interned at Google on the Maps team.`;

test("a faulted span stands down only for names one entry gives it", () => {
  // Named together in the entry that holds the work.
  assert.equal(foundInProfile("I built a course search service with FastAPI and Postgres", profile), true);
  // A plain statement of a skill rests on the skills list.
  assert.equal(foundInProfile("I am comfortable with Docker and Kubernetes", profile), true);
});

test("the Known gaps section vouches for nothing the applicant claims", () => {
  assert.equal(foundInProfile("I have used Redis to cache search results", profile), false);
});

test("names are matched as whole words, not inside other words", () => {
  // "Go" appears in the profile only inside "Google", outside the skills list.
  assert.equal(foundInProfile("I shipped a Go service for Maps", profile), false);
  assert.equal(foundInProfile("I interned at Google on Maps", profile), true);
  // "5" appears only inside "2025".
  assert.equal(foundInProfile("I cut query time to 5 ms with FastAPI", profile), false);
});

test("names from two entries are a recombination the profile does not state", () => {
  // FastAPI is one project's, React another's.
  assert.equal(foundInProfile("I built a React front end for a FastAPI service", profile), false);
});

test("work done does not rest on a skills list", () => {
  // Docker and Kubernetes are only listed as skills; no entry says they were deployed.
  assert.equal(foundInProfile("I deployed the dashboard with Docker and Kubernetes", profile), false);
});

test("a duration, a frequency or the applicant's standing needs the entry's own words", () => {
  assert.equal(foundInProfile("I have three years of FastAPI and Postgres experience", profile), false);
  assert.equal(foundInProfile("I led the team that built the FastAPI and Postgres service", profile), false);
  assert.equal(foundInProfile("I used React daily on the dashboard", profile), false);
});

test("a span with no names to check is left to the checking model", () => {
  assert.equal(foundInProfile("I enjoy solving hard problems", profile), false);
});
