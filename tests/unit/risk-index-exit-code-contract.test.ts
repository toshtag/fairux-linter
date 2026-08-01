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
 * The Risk Index has no model yet, so the guard here is that the CLI does not read one at all. When
 * it legitimately renders one, this test fails — and that failure is the point: whoever wires it up
 * has to decide the exit-code question deliberately and replace this with a behavioural check that
 * the code still depends only on severities.
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

  it("does not read a Risk Index anywhere in the CLI", () => {
    for (const source of cliSources()) {
      expect(
        /riskIndex|RiskIndex/.test(source.text),
        `${source.file} references a Risk Index. Before wiring one into the CLI, decide the exit-code ` +
          "question deliberately: the exit code must stay a function of finding severities and " +
          "--fail-on, never of a score. Replace this assertion with a behavioural one that proves it.",
      ).toBe(false);
    }
  });

  it("has no flag that would gate the exit code on a score", () => {
    const index = cliSources().find((source) => source.file === "index.ts");
    expect(index).toBeDefined();
    expect(index?.text).not.toMatch(/--fail-on-score|--min-score|--max-risk/);
  });
});
