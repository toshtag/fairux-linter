import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";
import { CLI_PROCESS_BUDGET_MS, launchesTheCli } from "../../apps/cli/test/cli-process-budget.js";

/**
 * Give the CLI-launching test files their own per-test budget, and nothing else.
 *
 * A setup file runs once per test file, before that file is imported, and `expect.getState()`
 * already knows which file it is about to run — so one place can decide the budget for the
 * test files that pay for process startup, without a line in each of them and without
 * touching the global.
 *
 * The decision is made from the file's own source. It used to be made from a frozen list of
 * twenty-six repository-relative paths, with a test that derived the same set and compared: a
 * second copy of the answer, plus an alarm that goes off only after someone has written a CLI test
 * and run it on the ten-second budget. Reading the file costs one `readFileSync` per test file and
 * removes the list, the comparison, and the interval where they disagree.
 *
 * The alternative shapes were both worse. A larger `testTimeout` in `vitest.config.ts` would buy
 * the same green runs by hiding the boundary for every test that launches nothing. A second
 * vitest project would change what `--shard` partitions, and CI shards; a local gate and a CI lane
 * that disagree about which tests exist is a worse problem than the one being fixed.
 *
 * Deliberately silent about every other file: they keep the global 10 seconds, which is the
 * right budget for a test that does no I/O and the reason the global is not being raised.
 */
const testPath = (expect.getState() as { testPath?: string }).testPath;

if (testPath && launchesTheCli(readFileSync(testPath, "utf8"))) {
  vi.setConfig({ testTimeout: CLI_PROCESS_BUDGET_MS });
}
