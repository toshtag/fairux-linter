import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/check-doc-references.mjs");

/**
 * The check that re-reads the documents so nobody has to remember to.
 *
 * `pnpm rules:reviews:check:approved` and `packages/rules/reviews/maintainer-approval.json` were both
 * removed and both stayed in the docs, telling readers to run and open things that were not there.
 * The link checker sees markdown links; it does not see a command or a bare path in backticks.
 */
describe("the document reference check", () => {
  it("passes on the repository as it stands", () => {
    const output = execFileSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
    expect(output).toContain("references in documents all resolve");
  });

  it("reads a non-trivial number of references, so passing is not vacuous", () => {
    const output = execFileSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
    const count = Number(output.match(/✓ (\d+) command and path/)?.[1] ?? 0);
    expect(count).toBeGreaterThan(100);
  });

  it("names its exceptions with a reason rather than widening the pattern", () => {
    // Every allowance is a decision somebody can disagree with. A rule broad enough to cover them
    // silently would cover a real regression too.
    const source = readFileSync(SCRIPT, "utf8");
    for (const reason of ["must reject", "one level in", "outside a workspace"]) {
      expect(source).toContain(reason);
    }
  });

  it("has no directory it skips, so every document is read", () => {
    // There used to be one, for a closed review packet that named files it had outlived. Removing
    // the packet removed the reason, and an exemption nothing uses is an exemption nobody re-reads.
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toContain("HISTORICAL_DIRS");
  });
});
