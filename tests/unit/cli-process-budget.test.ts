import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_PROCESS_BUDGET_MS,
  CLI_SPAWN_TIMEOUT_MS,
  launchesTheCli,
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
 * the same green runs by removing the boundary from every test that launches nothing; this
 * file's job is to make that impossible to do quietly.
 */
describe("the CLI process budget", () => {
  it("leaves the hang detector reachable", () => {
    // The property the whole change exists for. If a CLI hangs, `spawnSync` must be what kills it,
    // because that failure names the command; a test timeout names only the test.
    expect(CLI_PROCESS_BUDGET_MS).toBeGreaterThan(CLI_SPAWN_TIMEOUT_MS);
  });

  it("does not raise the global timeout", () => {
    // The one change that would make this whole file pointless. A test that does no I/O has no
    // reason to be allowed ten seconds, let alone fifty.
    const config = read("vitest.config.ts");
    expect(config).toContain("testTimeout: 10_000");
    expect(config).toContain("./tests/setup/cli-process-budget.ts");
  });

  it("raises the budget from the file's own source, not from a list", () => {
    // The setup file is where the scoping happens. It asks the same predicate this file asks, so a
    // new CLI test gets the budget on its first run rather than on the run that fails.
    const setup = read("tests/setup/cli-process-budget.ts");
    expect(setup).toContain("launchesTheCli(readFileSync(testPath");
    expect(setup).toContain("CLI_PROCESS_BUDGET_MS");
  });
});

/**
 * Every `node` launch of the CLI in one source file, with whether its own call carries the detector.
 *
 * Each match is walked to the end of its call expression by balancing parentheses, so the answer is
 * about *that* call and not about the file. Two things make that necessary, and both were live
 * defects rather than hypotheticals:
 *
 * - a file may launch the CLI several times and give the detector to only some of them, which is
 *   what a `detectors > 0` check let through;
 * - a file may pass the constant to a command that is not the CLI — `cli-source-map-audit` spawns
 *   `tar` — which is what a `detectors === launches` comparison would let through.
 *
 * Not a parser. It assumes the argument list is balanced TypeScript, which it is, and that a
 * `timeout: CLI_SPAWN_TIMEOUT_MS` inside the call belongs to it, which holds because these calls
 * take one options object.
 */
function cliLaunchSites(source: string): { line: number; hasDetector: boolean }[] {
  const launch = /(?:spawnSync|execFileSync)\(\s*"node"/g;
  const sites: { line: number; hasDetector: boolean }[] = [];
  for (const match of source.matchAll(launch)) {
    let depth = 0;
    let end = match.index;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    sites.push({
      line: source.slice(0, match.index).split("\n").length,
      hasDetector: source.slice(match.index, end).includes("timeout: CLI_SPAWN_TIMEOUT_MS"),
    });
  }
  return sites;
}

describe("which test files launch the CLI", () => {
  const trackedTests = execFileSync("git", ["ls-files", "*.test.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  /** The set the setup file computes, computed the same way, over every tracked test file. */
  const cliTests = trackedTests.filter((file) => launchesTheCli(read(file)));

  it("finds test files at all, so the loops below are not vacuous", () => {
    expect(trackedTests.length).toBeGreaterThan(100);
    expect(cliTests.length).toBeGreaterThan(10);
  });

  it("excludes files that spawn something other than the CLI", () => {
    // Each half of the predicate rules one of these out, and both spawn a real process. A glob over
    // `apps/cli/test` would hand them a fifty-second budget they have no use for.
    expect(cliTests).not.toContain("apps/cli/test/cli-source-map-audit.test.ts");
    expect(cliTests).not.toContain("tests/unit/build-output-contract.test.ts");
    expect(trackedTests).toContain("apps/cli/test/cli-source-map-audit.test.ts");
    expect(trackedTests).toContain("tests/unit/build-output-contract.test.ts");
  });

  it("gives every one of them the one hang detector", () => {
    // Four numbers were spelled across these files, and three of them were unreachable. One number,
    // imported, so the next reader does not have to work out which of four applies.
    for (const file of cliTests) {
      const source = read(file);
      expect(source, file).toContain("CLI_SPAWN_TIMEOUT_MS");
      expect(source, `${file} still passes a literal spawn timeout`).not.toMatch(
        /timeout:\s*\d[\d_]*/,
      );
    }
  });

  it("leaves no CLI launch without a hang detector", () => {
    // Per call site, not per file, and this is the second version of this check. The first asked
    // whether a file had *at least one* detector:
    //
    //     expect(detectors).toBeGreaterThan(0);
    //
    // which a file with five launches and one detector satisfies. It reported "no CLI launch
    // without a hang detector" while establishing "at least one launch has one", and five launches
    // across three files had none — `scan-journey` 4/1, `list-rules` 5/4, `risk-index` 2/1. That is
    // the same defect the budget work was opened for: a per-process timeout written down and unable
    // to fire.
    //
    // Comparing two totals would close that gap and open another: a `timeout: CLI_SPAWN_TIMEOUT_MS`
    // on a `tar` or `git` spawn in the same file would count toward the launches' total. So each
    // launch is checked in isolation.
    for (const file of cliTests) {
      const sites = cliLaunchSites(read(file));
      expect(sites.length, `${file} matched the predicate but launches nothing`).toBeGreaterThan(0);
      const undetected = sites.filter((site) => !site.hasDetector).map((site) => site.line);
      expect(
        undetected,
        `${file} launches the CLI at ${sites.length} site(s); ${undetected.length} of them have no ` +
          `timeout: CLI_SPAWN_TIMEOUT_MS (line ${undetected.join(", line ")})`,
      ).toEqual([]);
    }
  });

  it("counts a launch written across several lines", () => {
    // A line-based `grep -c` finds three launches in `scan-journey.test.ts`; the fourth is written
    // across lines and was one of the three with no detector. A check that counted lines would have
    // agreed with itself and missed it.
    const source = read("apps/cli/test/scan-journey.test.ts");
    const perLine = source
      .split("\n")
      .filter((line) => /(?:spawnSync|execFileSync)\(\s*"node"/.test(line)).length;
    const sites = cliLaunchSites(source);
    expect(sites.length).toBeGreaterThan(perLine);
  });

  it("does not credit a launch with another command's timeout", () => {
    // The failure mode a totals comparison would have. `tar` carrying the constant must not make a
    // `node` launch beside it look detected.
    const sites = cliLaunchSites(`
      execFileSync("tar", ["-xzOf", tarball], { timeout: CLI_SPAWN_TIMEOUT_MS });
      spawnSync("node", [cliBin, "rules"], { encoding: "utf8" });
    `);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.hasDetector).toBe(false);
  });

  it("reads a detector that belongs to the launch it is inside", () => {
    const sites = cliLaunchSites(`
      spawnSync("node", [cliBin, "rules"], { encoding: "utf8", timeout: CLI_SPAWN_TIMEOUT_MS });
    `);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.hasDetector).toBe(true);
  });
});
