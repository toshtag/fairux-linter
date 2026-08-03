import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeFixPlan, planFixes, writeFixes } from "../src/fix.js";
import { composeCliRulePacks } from "../src/load-rule-pack.js";
import { scanFileReport, scanFilesReport } from "../src/scan-file.js";

/**
 * The gap between planning a fix and writing it.
 *
 * `planFixes()` reads every file and hashes it, and `writeFixes()` used to write the planned bytes
 * without looking again. Anything that touched the file in between — an editor saving, a watcher
 * rebuilding, another agent in the same tree — was overwritten by a plan computed against bytes that
 * no longer existed. `--fix-write` is documented as safe-only, and that was not safe.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixablePack = resolve(here, "../../../tests/fixtures/remediation-rule-pack/fixable-pack.mjs");

const PAGE = '<main>\n  <label><input type="checkbox" checked> Email me offers</label>\n</main>\n';
const OTHER_WORK = "<main>SOMEONE ELSE WAS EDITING THIS</main>\n";

async function packs() {
  const composed = await composeCliRulePacks([fixablePack], { includeExperimental: false });
  return composed.packs;
}

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-fix-safety-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a plan written after the file changed", () => {
  it("writes nothing, and says why", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");

      const plan = planFixes(
        scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
      );
      expect(plan.changedFiles).toHaveLength(1);

      // Between the plan and the write, someone else's work lands in the file.
      writeFileSync(file, OTHER_WORK, "utf8");

      const outcome = writeFixes(plan);
      expect(outcome.ok).toBe(false);
      expect(outcome.written).toHaveLength(0);
      // Compared against the plan's own paths: a remediation names its file the way the report does,
      // which is relative to where the scan ran.
      expect(outcome.stale.map((entry) => entry.file)).toEqual(plan.changedFiles);
      // The other work survived, byte for byte. This is the whole point.
      expect(readFileSync(file, "utf8")).toBe(OTHER_WORK);

      const described = describeFixPlan(plan, outcome);
      expect(described).toContain("changed after the plan was made");
      expect(described).toContain("re-run the scan");
      expect(described).toContain("0 applied");
      // Never reported as applied, because it was not.
      expect(described).not.toMatch(/^fairux: applied /m);
    });
  });

  it("refuses every file when only one of them changed", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const first = join(dir, "a.html");
      const second = join(dir, "b.html");
      writeFileSync(first, PAGE, "utf8");
      writeFileSync(second, PAGE, "utf8");

      const plan = planFixes(
        scanFilesReport([first, second], { format: "json", toolVersion: "test", rulePacks }),
      );
      expect(plan.changedFiles).toHaveLength(2);

      writeFileSync(second, OTHER_WORK, "utf8");

      const outcome = writeFixes(plan);
      expect(outcome.ok).toBe(false);
      expect(outcome.written).toHaveLength(0);
      // The untouched file is not written either: a preflight that stopped at the first bad file
      // would leave the tree half-fixed, which is the state hardest to recover from.
      expect(readFileSync(first, "utf8")).toBe(PAGE);
      expect(readFileSync(second, "utf8")).toBe(OTHER_WORK);
    });
  });

  it("refuses when the file was deleted after the plan", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      const plan = planFixes(
        scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
      );

      rmSync(file);

      const outcome = writeFixes(plan);
      expect(outcome.ok).toBe(false);
      expect(outcome.written).toHaveLength(0);
      // Not recreated. A fix is a change to a file that exists, not a way to resurrect one.
      expect(readdirSync(dir)).not.toContain("page.html");
    });
  });
});

describe("a plan written against the file it was planned from", () => {
  it("applies it, and reports what it wrote", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      const plan = planFixes(
        scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
      );

      const outcome = writeFixes(plan);
      expect(outcome.ok).toBe(true);
      expect(outcome.written).toEqual(plan.changedFiles);
      expect(outcome.stale).toHaveLength(0);
      expect(readFileSync(file, "utf8")).toContain('<input type="checkbox">');
      expect(describeFixPlan(plan, outcome)).toContain("applied fixtures/pre-checked-box");
    });
  });

  it("leaves no temporary file behind", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      const plan = planFixes(
        scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
      );
      writeFixes(plan);
      // The rename is the last step, and a leftover `.page.html.<pid>.<n>.tmp` would mean it did not
      // happen — or that a copy was left where a rename was claimed.
      expect(readdirSync(dir)).toEqual(["page.html"]);
    });
  });

  it("is a no-op when nothing would change", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, "<main><p>Nothing to fix here.</p></main>\n", "utf8");
      const plan = planFixes(
        scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
      );
      const outcome = writeFixes(plan);
      // Vacuously fine rather than a failure: there was nothing to write, and nothing went wrong.
      expect(outcome.ok).toBe(true);
      expect(outcome.written).toHaveLength(0);
    });
  });
});
