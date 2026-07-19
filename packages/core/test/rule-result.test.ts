import { describe, expect, it } from "vitest";
import { RulePackError } from "../src/index.js";
import { validateCreateFindingInput, validateRuleFindings } from "../src/rule-result.js";
import type { Rule } from "../src/types.js";

const rule: Rule = {
  meta: {
    id: "test/rule-result",
    title: "Rule result",
    category: "obstruction",
    defaultSeverity: "medium",
    defaultConfidence: "low",
    defaultEnabled: true,
    tags: [],
    version: "1.0.0",
  },
  evaluate: () => [],
};

function expectRulePackError(fn: () => void, forbiddenMessage?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RulePackError);
    if (forbiddenMessage) expect(String(error)).not.toContain(forbiddenMessage);
    return;
  }
  throw new Error("expected RulePackError");
}

describe("rule result normalization", () => {
  it("does not read unknown-field getters while building validation errors", () => {
    let reads = 0;
    const input = {
      evidence: [],
      description: "description",
      whyItMatters: "why",
      recommendation: "fix",
    };
    Object.defineProperty(input, "unknown", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error("getter failure");
      },
    });

    expectRulePackError(() => validateCreateFindingInput(input, rule), "getter failure");
    expect(reads).toBe(0);
  });

  it("does not read custom array property getters while building validation errors", () => {
    let reads = 0;
    const findings: unknown[] = [];
    Object.defineProperty(findings, "custom", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error("getter failure");
      },
    });

    expectRulePackError(() => validateRuleFindings(findings, rule), "getter failure");
    expect(reads).toBe(0);
  });

  it("converts known-property getter failures to RulePackError", () => {
    let reads = 0;
    const input = {
      description: "description",
      whyItMatters: "why",
      recommendation: "fix",
    };
    Object.defineProperty(input, "evidence", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error("getter failure");
      },
    });

    expectRulePackError(() => validateCreateFindingInput(input, rule), "getter failure");
    expect(reads).toBe(1);
  });
});
