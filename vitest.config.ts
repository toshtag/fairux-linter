import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const sdkPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL("./packages/sdk/package.json", import.meta.url)), "utf8"),
) as { version: string };

/**
 * What a test file is guessed to cost, for the purpose of cutting the suite into equal shards.
 *
 * Vitest's own `shard()` sorts by a SHA-1 of the file path and cuts into equal *counts*, which is
 * cost-blind: the run then waits on whichever third happened to collect the expensive files.
 *
 * What costs time here is starting a `node` process, not parsing source or running assertions. So
 * the estimate is the number of CLI launches a file makes, plus a small term for file size to
 * separate files that launch equally.
 *
 * It was the number of test cases, on the reasoning that "a test that spawns spawns about once".
 * That stopped being true: the CLI suites now drive the built binary several times per case, and a
 * file of many cheap assertions was being weighted ahead of a file with a handful of spawns. The
 * correlations and the resulting split are in the pull request that changed it — they are a
 * measurement of one tree, and re-measuring is a command away.
 *
 * Deliberately crude. Measured durations would be better and are not worth it: they mean a
 * checked-in table that goes stale and a drift check to catch that, when two numbers the file
 * already carries get within a few seconds of an optimal split.
 *
 * Wrong about any single file, right about the pile — which is all a shard split needs.
 */
function estimatedCost(specification: TestSpecification): number {
  const path = specification.moduleId;
  try {
    const source = readFileSync(path, "utf8");
    // A launch of the built CLI is a process start, and it dominates everything else a test file
    // does: the suite's slowest files are the ones that spawn most, not the ones with most cases.
    // Counting cases put a file of many cheap assertions ahead of a file with a few spawns, which
    // is the wrong way round — file size is kept only to separate files that spawn equally.
    const launches = source.match(/(?:spawnSync|execFileSync)\(\s*"node"/g)?.length ?? 0;
    return launches * 1_500 + statSync(path).size / 200;
  } catch {
    // A file that cannot be read still has to land somewhere. A middling weight is a safer guess
    // than zero, which would pile every unreadable file into the same shard.
    return 1_000;
  }
}

/**
 * Longest-processing-time bin packing, run identically in every shard.
 *
 * Each shard computes the whole partition and keeps one bin, so the runs have to agree exactly.
 * That is why the sort breaks ties on the module id and the search takes the first minimum rather
 * than any minimum: two shards disagreeing would run some files twice and others never, and nothing
 * downstream would notice.
 */
class BalancedSequencer extends BaseSequencer {
  override async shard(specifications: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return specifications;

    const weighted = [...specifications]
      .map((specification) => ({ specification, cost: estimatedCost(specification) }))
      .sort((a, b) =>
        b.cost !== a.cost
          ? b.cost - a.cost
          : a.specification.moduleId < b.specification.moduleId
            ? -1
            : 1,
      );

    const bins: TestSpecification[][] = Array.from({ length: shard.count }, () => []);
    const totals = new Array<number>(shard.count).fill(0);
    for (const { specification, cost } of weighted) {
      const target = totals.indexOf(Math.min(...totals));
      bins[target]?.push(specification);
      totals[target] = (totals[target] ?? 0) + cost;
    }
    return bins[shard.index - 1] ?? [];
  }
}

export default defineConfig({
  define: {
    __FAIRUX_SDK_VERSION__: JSON.stringify(sdkPackage.version),
  },
  test: {
    // Pick up *.test.ts across all packages/apps (node_modules excluded by default).
    include: ["**/*.{test,spec}.ts"],
    exclude: [...configDefaults.exclude, "examples/rule-pack-author/**"],
    environment: "node",
    // The budget for a test that does no I/O, and it stays that way. The files that
    // launch the CLI as a real process get a larger one from the setup file below — see
    // `apps/cli/test/cli-process-budget.ts` for why the two are ordered rather than merged.
    testTimeout: 10_000,
    // Runs once per test file, before the file is imported. It reads that file's own source and
    // raises the budget only when the file launches the built CLI as a process. A global large
    // enough for several `node` starts would hide the boundary for every test that starts nothing.
    setupFiles: ["./tests/setup/cli-process-budget.ts"],
    sequence: { sequencer: BalancedSequencer },
  },
});
