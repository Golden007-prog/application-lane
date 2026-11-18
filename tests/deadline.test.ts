import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { withinTime } from "../src/server/deadline";

// Garbage collection on demand, as under the browser suite's load.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const collect = async () => {
  for (let i = 0; i < 5; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const aborts = (signal: AbortSignal, within: number) =>
  new Promise<boolean>((resolve) => {
    signal.addEventListener("abort", () => resolve(true), { once: true });
    setTimeout(() => resolve(signal.aborted), within);
  });

test("a time limit still fires after garbage collection, where AbortSignal.any's can be lost", async () => {
  const parent = new AbortController();
  const limited = withinTime(150, parent.signal);
  await collect();
  assert.equal(await aborts(limited, 1000), true);
  assert.equal((limited.reason as DOMException).name, "TimeoutError");
  // Node's own combination, the cause: shown, not relied on (a later Node may fix it).
  const combined = AbortSignal.any([new AbortController().signal, AbortSignal.timeout(150)]);
  await collect();
  const lost = !(await aborts(combined, 1000));
  if (lost) assert.equal(combined.aborted, false);
});

test("a time limit follows its caller's signal, and with none simply times out", async () => {
  const parent = new AbortController();
  const limited = withinTime(60_000, parent.signal);
  parent.abort(new Error("cancelled"));
  assert.equal(limited.aborted, true);
  assert.equal((limited.reason as Error).message, "cancelled");
  // Already aborted: at once.
  assert.equal(withinTime(60_000, parent.signal).aborted, true);
  assert.equal(await aborts(withinTime(50), 1000), true);
});
