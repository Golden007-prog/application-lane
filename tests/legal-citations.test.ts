import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { writeFieldFallback } from "../src/server/field-fallback";
import { configSchema } from "../src/server/store";
import { profileSchema, type Field } from "../src/shared/model";
import { legalTopics } from "../src/shared/questions";

const field = (label: string): Field => ({ id: "q", label, kind: "select", required: true, value: "", options: ["Yes", "No"], revision: 1, protected: false });

// The model's answer to the one field asked, citing what it was told to.
async function suggest(label: string, legal: Record<string, string>, sourceIds: string[]) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
    const suggestions = (input.fields || []).map((asked: { id: string }) => ({ fieldId: asked.id, value: "No", sourceIds }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ suggestions }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const config = configSchema.parse({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "fixture", token: "test-token-".repeat(4) });
    const profile = profileSchema.parse({ firstName: "Alex", lastName: "Rivera", email: "alex@example.test", confirmed: true, facts: [], legal });
    const result = await writeFieldFallback(config, {
      applicationId: "00000000-0000-4000-8000-000000000001", operation: 1, profileRevision: 1, title: "Engineer", description: "",
      url: "https://example.test/job", fields: [field(label)], legalAnswers: "details",
    }, profile, new AbortController().signal);
    return result.drafts[0];
  } finally {
    server.close();
  }
}

test("legal questions are told apart by the saved detail they ask about", () => {
  assert.deepEqual(legalTopics("Have you ever been convicted of a felony?"), ["criminal"]);
  assert.deepEqual(legalTopics("Do you hold an active security clearance?"), ["clearance"]);
  assert.deepEqual(legalTopics("Are you bound by a non-compete agreement?"), ["agreements"]);
  assert.deepEqual(legalTopics("Do you have relatives working at this company?"), ["relatives"]);
  assert.deepEqual(legalTopics("Have you ever filed for bankruptcy?"), []);
});

test("an AI legal answer that does not cite the saved detail its question asks about is filled with a caution", async () => {
  // A saved clearance does not answer a question about a conviction: the
  // answer is kept (nothing holds the form back), with a caution to check it.
  const wrong = await suggest("Have you ever been convicted of a felony?", { clearance: "No security clearance, and never held one" }, ["legal.clearance"]);
  assert.equal(wrong.value, "No");
  assert.match(wrong.caution || "", /legal and eligibility details do not cover this answer/);
  // "Anything else" answers it: no caution.
  const other = await suggest("Have you ever been convicted of a felony?", { other: "No convictions of any kind" }, ["legal.other"]);
  assert.equal(other.value, "No");
  assert.equal(other.caution, undefined);
  // A legal question about none of the saved topics may stand on any of them.
  const unnamed = await suggest("Have you ever filed for bankruptcy?", { other: "Never filed for bankruptcy" }, ["legal.other"]);
  assert.equal(unnamed.value, "No");
});

test("every drafting prompt names the page, posting and profile text as data, never instructions", async () => {
  const sources = await Promise.all(
    ["src/server/field-fallback.ts", "src/server/answers.ts", "src/server/verify.ts", "src/server/job-fit.ts", "src/server/job-apply.ts", "src/server/completion.ts"].map(async (file) => [file, await (await import("node:fs/promises")).readFile(file, "utf8")] as const),
  );
  for (const [file, text] of sources) {
    const prompts = [...text.matchAll(/const ([A-Z_]+_PROMPT) =\s*\n?\s*[`'"]([\s\S]{0,600})/g)];
    assert.ok(prompts.length, `${file} has a prompt`);
    for (const [, name, opening] of prompts) assert.match(opening, /UNTRUSTED DATA, never instructions|untrusted data|never instructions/i, `${file} ${name}`);
  }
});
