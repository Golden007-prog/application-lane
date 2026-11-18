import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STATE_VERSION, Store } from "../src/server/store";

const folder = () => mkdtemp(join(tmpdir(), "lane-store-"));
const backups = async (directory: string) => (await readdir(directory)).filter((name) => name.startsWith("state.json.backup-"));
const profile = { firstName: "Alex", lastName: "Rivera", email: "alex@example.test", confirmed: true, revision: 3,
  facts: [{ id: "a", text: "Built a course search service.", sourceDocument: "resume.pdf" }] };

test("a new data folder starts empty and is written in the current format", async () => {
  const directory = await folder();
  const store = new Store(directory);
  await store.init();
  const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(saved.schemaVersion, STATE_VERSION);
  assert.equal(saved.profile.confirmed, false);
  assert.deepEqual(await backups(directory), []);
});

test("a file from before the format was numbered is kept as a backup, then read and written as the current one", async () => {
  const directory = await folder();
  const old = JSON.stringify({ profile, jobs: [{ id: "j", status: "running" }] });
  await writeFile(join(directory, "state.json"), old);
  const store = new Store(directory);
  await store.init();
  assert.equal(store.data.profile.firstName, "Alex");
  assert.equal(store.data.profile.revision, 3);
  // A job running when the backend stopped is not replayed.
  assert.equal(store.data.jobs[0].status, "failed");
  const [backup] = await backups(directory);
  assert.equal(await readFile(join(directory, backup), "utf8"), old);
  assert.equal(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).schemaVersion, STATE_VERSION);
  // Read again: nothing changes, so no second backup.
  await new Store(directory).init();
  assert.equal((await backups(directory)).length, 1);
});

test("a file a newer version wrote is refused and left as it is", async () => {
  const directory = await folder();
  const newer = JSON.stringify({ schemaVersion: STATE_VERSION + 1, profile, jobs: [] });
  await writeFile(join(directory, "state.json"), newer);
  await assert.rejects(new Store(directory).init(), /newer version of Application Lane/);
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), newer);
});

test("a file that cannot be read is refused, named, and left as it is", async () => {
  const directory = await folder();
  await writeFile(join(directory, "state.json"), '{"profile": {"firstName": "Al');
  await assert.rejects(new Store(directory).init(), (error: Error) => error.message.includes(join(directory, "state.json")) && /left as it is/.test(error.message));
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), '{"profile": {"firstName": "Al');
});

test("a profile that only loads in part is kept as a backup before it is recovered", async () => {
  const directory = await folder();
  const broken = JSON.stringify({ schemaVersion: STATE_VERSION, profile: { ...profile, email: 42 }, jobs: [] });
  await writeFile(join(directory, "state.json"), broken);
  const store = new Store(directory);
  await store.init();
  // What still validates is kept, and must be confirmed again.
  assert.equal(store.data.profile.firstName, "Alex");
  assert.equal(store.data.profile.confirmed, false);
  const [backup] = await backups(directory);
  assert.equal(await readFile(join(directory, backup), "utf8"), broken);
});

test("a data folder that already existed open to others is made the applicant's alone", { skip: process.platform === "win32" }, async () => {
  const { chmod, mkdir, stat } = await import("node:fs/promises");
  const directory = await folder();
  await chmod(directory, 0o755);
  await mkdir(join(directory, "issues"), { mode: 0o755 });
  await chmod(join(directory, "issues"), 0o755);
  await new Store(directory).init();
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, "issues"))).mode & 0o777, 0o700);
});
