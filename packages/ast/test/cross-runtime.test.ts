import { scan } from "@fairux/core";
import { allRules, dictionary } from "@fairux/rules";
import { describe, expect, it } from "vitest";
import { parseSource } from "../src/index.js";

/**
 * The point of the AST adapter (ADR P6-T2): existing rules run on JSX/TSX source with zero
 * changes — but only on what's STATICALLY known, and never above medium confidence.
 */

const ruleIds = (html: string) =>
  scan(parseSource(html, { file: "C.tsx" }), allRules, { dictionary }).findings.map(
    (f) => f.ruleId,
  );

describe("existing rules run on the AST adapter (static-only, capped confidence)", () => {
  it("flags a literally pre-checked marketing box on a consent page", () => {
    const report = scan(
      parseSource(
        `const C = () => (
          <div>
            <h1>Cookie consent</h1>
            <label><input type="checkbox" checked /> Email me marketing offers</label>
          </div>
        );`,
        { file: "C.tsx" },
      ),
      allRules,
      { dictionary },
    );
    const checked = report.findings.find((f) => f.ruleId === "consent/checked-checkbox");
    expect(checked).toBeDefined();
    // ADR §5: AST findings are capped at medium confidence (source has unknowns).
    expect(checked?.confidence).not.toBe("high");
  });

  it("does NOT flag a checkbox whose checked is a dynamic expression (unknown != true)", () => {
    const ids = ruleIds(
      `const C = ({on}) => (
        <div><h1>Cookie consent</h1>
          <label><input type="checkbox" checked={on} /> Email me marketing offers</label>
        </div>
      );`,
    );
    expect(ids).not.toContain("consent/checked-checkbox");
  });

  it("flags scarcity copy that is a static string", () => {
    expect(ruleIds(`const C = () => <p>Only 2 left in stock!</p>;`)).toContain(
      "scarcity/scarcity-phrase",
    );
  });

  it("does not flag scarcity copy that is entirely dynamic text", () => {
    // <p>{message}</p> — the text is unknown, so copy rules can't (and must not) fire.
    expect(ruleIds(`const C = ({message}) => <p>{message}</p>;`)).not.toContain(
      "scarcity/scarcity-phrase",
    );
  });

  it("caps every finding on an AST document at medium confidence", () => {
    const report = scan(
      parseSource(
        `const C = () => (
          <div><h1>Cookie consent</h1>
            <label><input type="checkbox" checked /> Subscribe to partner marketing offers</label>
          </div>
        );`,
        { file: "C.tsx" },
      ),
      allRules,
      { dictionary },
    );
    expect(report.findings.length).toBeGreaterThan(0);
    for (const f of report.findings) {
      expect(["low", "medium"]).toContain(f.confidence);
    }
  });
});
