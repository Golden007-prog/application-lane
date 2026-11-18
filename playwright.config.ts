import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// In the report fixer's checkout the tests are run by another account, and
// Chromium leaves folders there that the fixer's own `git clean` cannot
// delete; the next repair attempt then failed before it began. Its work area
// (.fixer) is removed by an account that can, so the tests' output goes there.
const fixer = existsSync(".fixer");
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  expect: { timeout: 15000 },
  // Each test has its own browser, backend, ports and temp folders, so tests
  // run side by side, as applications do in the extension.
  fullyParallel: true,
  workers: 3,
  // One more try for a test that fails: three browsers, backends and
  // extensions share the machine, and a busy moment can push one past a time
  // limit (a fill that took 28 s against a 25 s wait). A test that passes
  // only on its second try is reported as flaky, not hidden: those are the
  // ones to fix.
  retries: 1,
  // One run at a time on a machine: a second waits for the first to end.
  globalSetup: "./tests/support/global-setup.ts",
  outputDir: fixer ? ".fixer/test-results" : "test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: fixer ? ".fixer/playwright-report" : "playwright-report" }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
