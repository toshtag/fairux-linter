import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_LAUNCH_ALLOWANCE_MS,
  CLI_PROCESS_BUDGET_MS,
  CLI_PROCESS_TEST_FILES,
  CLI_SPAWN_TIMEOUT_MS,
  MAX_CLI_LAUNCHES_PER_TEST,
} from "../../apps/cli/test/cli-process-budget.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/**
 * The two timeouts around a CLI launch, and the order they have to be in.
 *
 * `pnpm verify:full` passed on an idle machine and failed under load, always in `test:built`, always
 * on a test that launches the CLI. The cause was an inversion: the global `testTimeout` was 10
 * seconds and the `spawnSync` timeouts the CLI tests wrote for themselves were 10000, 15000, 20000,
 * and 30000. Everything above the global was unreachable — vitest killed the test first — so the
 * hang detectors never fired, and a slow-but-correct run and a hung CLI produced the same
 * uninformative `Test timed out in 10000ms`.
 *
 * What is checked here is the ordering and the scope, not the numbers. Raising the global would buy
 * the same green runs by removing the boundary from the ~3,700 tests that launch nothing; this
 * file's job is to make that impossible to do quietly.
 */
describe("the CLI process budget", () => {
  it("leaves the hang detector reachable", () => {
    // The property the whole change exists for. If a CLI hangs, `spawnSync` must be what kills it,
    // because that failure names the command; a test timeout names only the test.
    expect(CLI_PROCESS_BUDGET_MS).toBeGreaterThan(CLI_SPAWN_TIMEOUT_MS);
  });

  it("is derived from the detector and an allowance, not chosen", () => {
    expect(CLI_PROCESS_BUDGET_MS).toBe(
      CLI_SPAWN_TIMEOUT_MS + MAX_CLI_LAUNCHES_PER_TEST * CLI_LAUNCH_ALLOWANCE_MS,
    );
    // An allowance that could not absorb a busy machine would leave the flake in place. The idle
    // per-launch cost measured ~150ms; this is twenty times it.
    expect(CLI_LAUNCH_ALLOWANCE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("does not raise the global timeout", () => {
    // The one change that would make this whole file pointless. A test that does no I/O has no
    // reason to be allowed ten seconds, let alone fifty.
    const config = read("vitest.config.ts");
    expect(config).toContain("testTimeout: 10_000");
    expect(config).toContain("./tests/setup/cli-process-budget.ts");
  });

  it("raises the budget for the listed files and no others", () => {
    // The setup file is where the scoping happens, so it has to consult the list rather than a
    // directory: a glob over `apps/cli/test` would also catch the file that spawns `tar`.
    const setup = read("tests/setup/cli-process-budget.ts");
    expect(setup).toContain("CLI_PROCESS_TEST_FILES.includes");
    expect(setup).toContain("CLI_PROCESS_BUDGET_MS");
  });
});

/**
 * The list, against what the files actually do.
 *
 * A list that is maintained by hand is a list that goes stale, so it is compared with the set
 * derived by reading every tracked test file. A new CLI test that spawns without joining the list
 * would silently inherit the ten-second budget — which is the bug, arriving again.
 */
describe("which test files launch the CLI", () => {
  /**
   * Files that start a `node` process against the built CLI entry point.
   *
   * Both halves are needed. `apps/cli/test/cli-source-map-audit.test.ts` mentions
   * `package/dist/index.js.map` and spawns `tar`; `tests/unit/build-output-contract.test.ts` spawns
   * `git`. Neither pays for a CLI start, and neither should be on the list.
   */
  const launchesTheCli = (source: string) =>
    /(?:spawnSync|execFileSync)\(\s*"node"/.test(source) &&
    /(?:apps\/cli\/)?dist\/index\.js(?!\.map)/.test(source);

  const trackedTests = execFileSync("git", ["ls-files", "*.test.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  it("finds test files at all, so the comparison is not vacuous", () => {
    expect(trackedTests.length).toBeGreaterThan(100);
  });

  it("is exactly the set of files that launch it", () => {
    const measured = trackedTests.filter((file) => launchesTheCli(read(file))).sort();
    expect(measured).toEqual([...CLI_PROCESS_TEST_FILES].sort());
  });

  it("gives every one of them the one hang detector", () => {
    // Four numbers were spelled across these files, and three of them were unreachable. One number,
    // imported, so the next reader does not have to work out which of four applies.
    for (const file of CLI_PROCESS_TEST_FILES) {
      const source = read(file);
      expect(source, file).toContain("CLI_SPAWN_TIMEOUT_MS");
      expect(source, `${file} still passes a literal spawn timeout`).not.toMatch(
        /timeout:\s*\d[\d_]*/,
      );
    }
  });

  it("leaves no CLI launch without a hang detector", () => {
    // Two of these files had no `timeout` at all, so a hung `--help` would have run until the test
    // timeout with nothing to say about which process was stuck.
    for (const file of CLI_PROCESS_TEST_FILES) {
      const source = read(file);
      const launches = source.match(/(?:spawnSync|execFileSync)\(\s*"node"/g)?.length ?? 0;
      const detectors = source.match(/timeout: CLI_SPAWN_TIMEOUT_MS/g)?.length ?? 0;
      expect(launches, `${file} matched the list but launches nothing`).toBeGreaterThan(0);
      expect(
        detectors,
        `${file} has ${launches} launch site(s) and ${detectors} detector(s)`,
      ).toBeGreaterThan(0);
    }
  });
});
