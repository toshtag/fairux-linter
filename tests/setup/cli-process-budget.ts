import { relative } from "node:path";
import { expect, vi } from "vitest";
import {
  CLI_PROCESS_BUDGET_MS,
  CLI_PROCESS_TEST_FILES,
} from "../../apps/cli/test/cli-process-budget.js";

/**
 * Give the CLI-launching test files their own per-test budget, and nothing else.
 *
 * A setup file runs once per test file, before that file is imported, and `expect.getState()`
 * already knows which file it is about to run — so one place can decide the budget for the
 * twenty-six files that pay for process startup, without a line in each of them and without
 * touching the global.
 *
 * The alternative shapes were both worse. A larger `testTimeout` in `vitest.config.ts` would buy
 * the same green runs by hiding the boundary for the ~3,700 tests that launch nothing. A second
 * vitest project would change what `--shard` partitions, and CI shards; a local gate and a CI lane
 * that disagree about which tests exist is a worse problem than the one being fixed.
 *
 * Deliberately silent about files not on the list: they keep the global 10 seconds, which is the
 * right budget for a test that does no I/O and the reason the global is not being raised.
 */
const testPath = (expect.getState() as { testPath?: string }).testPath;

if (testPath) {
  // Repository-relative, with POSIX separators, so the list reads the same on every platform and a
  // Windows runner compares the same strings a Linux one does.
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const relativePath = relative(repoRoot, testPath).split("\\").join("/");
  if (CLI_PROCESS_TEST_FILES.includes(relativePath)) {
    vi.setConfig({ testTimeout: CLI_PROCESS_BUDGET_MS });
  }
}
