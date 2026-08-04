import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_README = readFileSync(join(ROOT, "apps/cli/README.md"), "utf8");

/**
 * Two sentences in the CLI README outlived the code they described, and both said a shipped feature
 * does not exist — the failure mode a reader cannot detect, because the honest-sounding answer and
 * the wrong one are the same sentence.
 *
 * These are negative assertions on purpose. What the README says about the HTML report and about
 * suppressions is prose, and pinning prose is how a document stops being editable; what it may not
 * do is go back to denying a capability the build ships. Rewording is free, re-asserting is not.
 *
 * The behaviour itself is pinned where it belongs: `packages/report/test/html.test.ts` for the
 * panels, and the CLI's suppression and baseline suites for the rest.
 */
describe("what the CLI README says the build cannot do", () => {
  it("does not deny the HTML report's coverage or Risk Index panels", () => {
    // `toHtml` has rendered a coverage panel since coverage existed and a Risk Index panel since
    // `--risk-index` did. The README said "No charts, scores, or coverage. Those do not exist yet."
    expect(CLI_README).not.toContain("No charts, scores, or coverage");
    expect(CLI_README).not.toMatch(/coverage[^.]*do(es)? not exist/i);
    // The claim worth keeping, which is about a grade rather than about a panel.
    expect(CLI_README).toMatch(/no grade/i);
  });

  it("does not deny inline suppression directives", () => {
    // The README documents `fairux-disable-next-line` with examples, and then said it is not
    // supported — 72 lines apart, in one file, while `scan()` had been applying them for months.
    expect(CLI_README).toContain("fairux-disable-next-line");
    expect(CLI_README).not.toMatch(/fairux-disable[^)]*\)? are \*\*not\*\* supported/);
    expect(CLI_README).not.toMatch(/[Ii]nline source comments.*not.*supported/);
  });

  it("still says an inline directive leaves nothing for a baseline to match", () => {
    // The limitation that replaced the false claim, and the one thing a reader combining the two
    // mechanisms needs. It is not fixed, so it must not quietly stop being written down.
    expect(CLI_README).toMatch(/leaves no fingerprint/i);
  });
});
