import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema, type Field, type GenerationJob, type GenerationRequest } from "../src/shared/model";
import { GenerationQueue } from "../src/server/generation";
import { configSchema, Store } from "../src/server/store";

const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.test",
  confirmed: true,
  revision: 1,
  facts: [{ id: "a", text: "Built a TypeScript web application used by 2,000 students." }],
});
const field = (label: string, overrides: Partial<Field> = {}): Field => ({
  id: label,
  label,
  kind: "textarea",
  required: true,
  value: "",
  options: [],
  revision: 1,
  protected: false,
  ...overrides,
});
const cover = field("Cover letter", { kind: "file", required: false, documentKind: "cover" });
const request = (fields: Field[], overrides: Partial<GenerationRequest> = {}): GenerationRequest => ({
  applicationId: randomUUID(),
  operation: 1,
  profileRevision: 1,
  title: "TypeScript Engineer",
  company: "Acme",
  description: "Build TypeScript interfaces and automated tests.",
  url: "https://example.test/job",
  fields,
  ...overrides,
});
const narrative = {
  resume: [{ factId: "a", text: profile.facts[0].text }],
  coverLetter: [{ text: "Dear Hiring Team,", factIds: [] }, { text: profile.facts[0].text, factIds: ["a"] }],
  answers: [],
};
const hold = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { release, released };
};
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 30000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const summary = (job: GenerationJob) => (job.progress || []).map((item) => [item.name, item.kind, item.state, item.done, item.total]);
async function queueWith(options: { tailorDir?: string }, parts: ConstructorParameters<typeof GenerationQueue> extends [any, any, ...infer R] ? R : never) {
  const store = new Store(await mkdtemp(join(tmpdir(), "lane-progress-")));
  await store.init();
  store.data.profile = structuredClone(profile);
  const config = configSchema.parse({ postingLookup: false, token: "synthetic-token-".repeat(4), model: "fixture", endpoint: "http://127.0.0.1:9/v1", ...options });
  return new GenerationQueue(store, config, ...parts);
}

test("a job reports each document and question with the steps it has really passed", async () => {
  const gate = hold();
  const queue = await queueWith({}, [
    async (req) => {
      await gate.released;
      return { ...narrative, answers: req.fields.filter((f) => f.label !== "Cover letter").map((f) => ({ fieldId: f.id, value: `About ${f.label}`, factIds: [] })) };
    },
  ]);
  const job = await queue.enqueue(request([cover, field("Why Acme?"), field("What are you proud of?")]));
  await until(() => Boolean(job.progress?.length));
  // Held in the draft: the letter and both questions are being written, the
  // resume has not started, and nothing is counted done.
  assert.deepEqual(summary(job), [
    ["Tailored resume", "document", "waiting", 0, 1],
    ["Cover letter", "document", "running", 0, 3],
    ["Why Acme?", "question", "running", 0, 2],
    ["What are you proud of?", "question", "running", 0, 2],
  ]);
  gate.release();
  await until(() => job.status === "complete");
  assert.deepEqual(summary(job), [
    ["Tailored resume", "document", "done", 1, 1],
    ["Cover letter", "document", "done", 3, 3],
    ["Why Acme?", "question", "done", 2, 2],
    ["What are you proud of?", "question", "done", 2, 2],
  ]);
});

test("a step counts when it ends: the drafted letter is one step done while the answers are still being written", async () => {
  const gate = hold();
  const queue = await queueWith({ tailorDir: "unused" }, [
    async () => narrative,
    async () => {
      throw new Error("no tailoring in this test");
    },
    async (req) => {
      await gate.released;
      return { answers: req.fields.map((f) => ({ fieldId: f.id, value: `About ${f.label}`, factIds: [] })), warnings: [], withheld: [], sources: {} };
    },
  ]);
  const job = await queue.enqueue(request([cover, field("Why Acme?")]));
  // The letter's draft and the resume's plan (which failed here) have ended;
  // the answer has not.
  await until(() => job.progress?.[0]?.state === "failed");
  await until(() => job.progress?.[1]?.done === 1);
  assert.equal(job.progress![0].error, "no tailoring in this test");
  assert.deepEqual(summary(job).slice(1), [
    ["Cover letter", "document", "waiting", 1, 3],
    ["Why Acme?", "question", "running", 0, 2],
  ]);
  gate.release();
  await until(() => job.status === "complete");
  // The resume that could not be tailored stays failed, not "done".
  assert.deepEqual(summary(job).map((item) => item[2]), ["failed", "done", "done"]);
});

test("a job that fails leaves its unfinished items failed", async () => {
  const queue = await queueWith({}, [
    async () => {
      throw new Error("The model is not reachable.");
    },
  ]);
  const job = await queue.enqueue(request([cover, field("Why Acme?")]));
  await until(() => job.status === "failed");
  assert.deepEqual((job.progress || []).map((item) => [item.state, item.error]), [
    ["failed", "The model is not reachable."],
    ["failed", "The model is not reachable."],
    ["failed", "The model is not reachable."],
  ]);
});

test("a job that only drafts questions reports one item per question", async () => {
  const gate = hold();
  const queue = await queueWith({ tailorDir: "unused" }, [
    async () => narrative,
    async () => {
      throw new Error("unused");
    },
    async (req) => {
      await gate.released;
      return { answers: req.fields.map((f) => ({ fieldId: f.id, value: `About ${f.label}`, factIds: [] })), warnings: [], withheld: [], sources: {} };
    },
  ]);
  const job = await queue.enqueue(request([field("Why Acme?"), field("Gender", { kind: "select", options: ["Male", "Female"] })], { purpose: "answers" }));
  await until(() => Boolean(job.progress?.length));
  assert.deepEqual(summary(job), [["Why Acme?", "question", "running", 0, 2]]);
  gate.release();
  await until(() => job.status === "complete");
  assert.deepEqual(summary(job), [["Why Acme?", "question", "done", 2, 2]]);
});

test("a later step reports its kept documents as done and drafts only its new question", async () => {
  const gate = hold();
  let drafts = 0;
  const queue = await queueWith({ tailorDir: "unused" }, [
    async () => {
      drafts++;
      return narrative;
    },
    async () => {
      throw new Error("unused");
    },
    async (req) => {
      if (req.operation === 2) await gate.released;
      return { answers: req.fields.map((f) => ({ fieldId: f.id, value: `About ${f.label}`, factIds: [] })), warnings: [], withheld: [], sources: {} };
    },
  ]);
  const applicationId = randomUUID();
  const first = await queue.enqueue(request([cover], { applicationId }));
  await until(() => first.status === "complete" || first.status === "failed");
  const second = await queue.enqueue(request([field("What are you proud of?")], { applicationId, operation: 2 }));
  await until(() => second.progress?.some((item) => item.kind === "question" && item.state === "running") === true);
  assert.equal(drafts, 1);
  assert.deepEqual(summary(second), [
    ["Tailored resume", "document", "done", 1, 1],
    ["What are you proud of?", "question", "running", 0, 2],
  ]);
  gate.release();
  await until(() => second.status === "complete");
  assert.deepEqual(summary(second).map((item) => item[2]), ["done", "done"]);
});
