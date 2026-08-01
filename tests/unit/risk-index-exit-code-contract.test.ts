import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldFailOn } from "../../apps/cli/src/scan-file.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_SRC = join(ROOT, "apps/cli/src");

function cliSources(): { readonly file: string; readonly text: string }[] {
  return readdirSync(CLI_SRC)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ file: name, text: readFileSync(join(CLI_SRC, name), "utf8") }));
}

/**
 * The CLI's exit code answers "did this find something you said should fail the build". A Risk Index
 * score answers a different question, and a build that went red because a number crossed a threshold
 * would make the threshold the product.
 *
 * This began as a source-level guard: the CLI read no Risk Index, and the test failed the moment it
 * did — so whoever wired one up had to decide the exit-code question rather than inherit it. That
 * happened, the decision was to keep the exit code a function of findings and `--fail-on`, and the
 * behavioural proof now lives in `apps/cli/test/risk-index.test.ts`, which runs the CLI against a
 * page that scores and asserts the exit code ignores it.
 *
 * What remains here is what a behavioural test cannot show: that no flag exists which *would* gate
 * the exit code on a score, and that the decision path itself never reads one.
 */
describe("the CLI exit code does not depend on a Risk Index", () => {
  it("decides only from finding severities", () => {
    const withFindings = {
      kind: "single" as const,
      schemaVersion: "0.1" as const,
      toolVersion: "test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      input: { runtime: "html" as const },
      summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 1, high: 0 } },
      findings: [
        {
          id: "a#0",
          fingerprint: "0000000000000000",
          ruleId: "test/a",
          category: "consent" as const,
          severity: "medium" as const,
          confidence: "low" as const,
          title: "t",
          description: "d",
          evidence: [{ text: "e" }],
          whyItMatters: "w",
          recommendation: "r",
        },
      ],
    };
    expect(shouldFailOn(withFindings, "medium")).toBe(true);
    expect(shouldFailOn(withFindings, "high")).toBe(false);
    expect(
      shouldFailOn(
        {
          ...withFindings,
          findings: [],
          summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
        },
        "info",
      ),
    ).toBe(false);
  });

  it("keeps the index out of the decision path, wherever else it appears", () => {
    // `--risk-index` writes a second artifact and touches nothing else. The exit code is decided in
    // one place, and that place must not be able to see a score.
    const scanFile = cliSources().find((source) => source.file === "scan-file.ts");
    expect(scanFile?.text).not.toMatch(/riskIndex|RiskIndex/);

    // From the decision itself to the end of the action: the last `if (options.failOn` is the one
    // that sets the exit code, and nothing it reads may be a score.
    const index = cliSources().find((source) => source.file === "index.ts");
    const exitDecision = index?.text.slice(index.text.lastIndexOf("if (options.failOn")) ?? "";
    expect(exitDecision).not.toBe("");
    expect(exitDecision).toContain("shouldFailOn(emitted");
    expect(exitDecision.slice(0, exitDecision.indexOf("};"))).not.toMatch(/riskIndex|RiskIndex/);
  });

  it("has no flag that would gate the exit code on a score", () => {
    const index = cliSources().find((source) => source.file === "index.ts");
    expect(index).toBeDefined();
    expect(index?.text).not.toMatch(/--fail-on-score|--min-score|--max-risk/);
    // The one flag that does exist says what it does not do, in its own help text.
    expect(index?.text).toContain("never changes stdout or the exit code");
  });
});
