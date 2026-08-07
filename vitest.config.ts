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
 * cost-blind: three shards came out at 18.8s, 34.6s and 46.3s of CPU, and the run waits on the
 * 46.3. This estimate brings them to 33.3/31.9/34.6 — within six seconds of the 28.4s a perfect
 * split would give, and 25% off the slowest.
 *
 * A hundred milliseconds per test, plus a small term for file size. Crude on purpose:
 *
 * - **Measured durations would be better and are not worth it.** They mean a checked-in table that
 *   goes stale and a drift check to catch that — a second artifact to maintain, when this gets
 *   within six seconds of optimal from two numbers the file already carries.
 * - **File size alone does not work.** It predicts duration at r = 0.15 here, because what costs
 *   time is launching a `node` process rather than parsing source; weighting by it made the split
 *   *worse* than the hash.
 * - **Spawn count alone does not work either** (r = 0.63, slowest shard 38.1s). Test count is the
 *   better proxy precisely because a test that spawns spawns about once.
 *
 * Wrong about any single file, right about the pile — which is all a shard split needs.
 */
function estimatedCost(specification: TestSpecification): number {
  const path = specification.moduleId;
  try {
    const source = readFileSync(path, "utf8");
    const tests = source.match(/\bit\(|\bit\.each|\btest\(/g)?.length ?? 0;
    return tests * 100 + statSync(path).size / 50;
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
    // The budget for a test that does no I/O, and it stays that way. The twenty-six files that
    // launch the CLI as a real process get a larger one from the setup file below — see
    // `apps/cli/test/cli-process-budget.ts` for why the two are ordered rather than merged.
    testTimeout: 10_000,
    // Runs once per test file, before the file is imported, and raises the budget only for the
    // files on that list. A global large enough for eight `node` starts would hide the boundary for
    // the ~3,700 tests that start nothing.
    setupFiles: ["./tests/setup/cli-process-budget.ts"],
    sequence: { sequencer: BalancedSequencer },
  },
});
