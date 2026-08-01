import { describe, expect, it } from "vitest";
import {
  applySuppressionDirectives,
  findingSourceLine,
  parseSuppressionDirectives,
  SUPPRESSION_DIRECTIVE,
} from "../src/suppression-directive.js";

/**
 * Inline suppression directives.
 *
 * The file-based form refuses a blank reason because a suppression without an argument is a disabled
 * rule with extra steps. An inline form that dropped that requirement would be the loophole rather
 * than the convenience, so the refusal is repeated here — and repeated *loudly*, because a malformed
 * directive that silently suppressed nothing would leave a user believing a finding was accepted
 * when it was not.
 */

const comment = (text: string, startLine: number) => ({ text, startLine });
const finding = (ruleId: string, startLine?: number) => ({
  ruleId,
  evidence: startLine === undefined ? [] : [{ source: { startLine } }],
});

describe("parsing a directive", () => {
  it("reads the rule id and the reason", () => {
    const { directives, malformed } = parseSuppressionDirectives([
      comment(` ${SUPPRESSION_DIRECTIVE} scarcity/scarcity-phrase -- stock is live `, 4),
    ]);
    expect(malformed).toEqual([]);
    expect(directives).toEqual([
      { ruleId: "scarcity/scarcity-phrase", reason: "stock is live", startLine: 4 },
    ]);
  });

  it("ignores a comment that is not a directive", () => {
    expect(parseSuppressionDirectives([comment(" just a note ", 1)])).toEqual({
      directives: [],
      malformed: [],
    });
  });

  it("refuses a directive with no reason", () => {
    // The refusal this feature exists for.
    for (const text of [
      `${SUPPRESSION_DIRECTIVE} scarcity/scarcity-phrase`,
      `${SUPPRESSION_DIRECTIVE} scarcity/scarcity-phrase --`,
      `${SUPPRESSION_DIRECTIVE} scarcity/scarcity-phrase --   `,
    ]) {
      const { directives, malformed } = parseSuppressionDirectives([comment(text, 2)]);
      expect(directives, text).toEqual([]);
      expect(malformed[0]?.reason, text).toContain("no reason given");
    }
  });

  it("refuses a directive with no rule id, and says what the shape is", () => {
    const { malformed } = parseSuppressionDirectives([comment(SUPPRESSION_DIRECTIVE, 3)]);
    expect(malformed[0]?.reason).toContain("<rule-id> -- <reason>");
  });

  it("reports a malformed directive rather than ignoring it", () => {
    // Matching only well-formed directives would make every typo silent, and silence here reads as
    // "the suppression worked".
    const { malformed } = parseSuppressionDirectives([
      comment(`${SUPPRESSION_DIRECTIVE}`, 1),
      comment(`x ${SUPPRESSION_DIRECTIVE} rule/id -- fine`, 2),
    ]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.startLine).toBe(1);
  });
});

describe("which line a finding is on", () => {
  it("takes the first evidence carrying a source line", () => {
    expect(findingSourceLine({ evidence: [{ source: {} }, { source: { startLine: 9 } }] })).toBe(9);
  });

  it("has no answer for evidence with no line", () => {
    // A Figma node or a live DOM element. That is a property of the input, not something to
    // approximate — and neither input has comments to write a directive in either.
    expect(findingSourceLine({ evidence: [] })).toBeUndefined();
    expect(findingSourceLine({ evidence: [{ source: {} }] })).toBeUndefined();
  });
});

describe("applying directives", () => {
  const directives = parseSuppressionDirectives([
    comment(`${SUPPRESSION_DIRECTIVE} scarcity/scarcity-phrase -- deliberate`, 5),
  ]).directives;

  it("suppresses the finding on the very next line", () => {
    const { kept, applied } = applySuppressionDirectives(
      [finding("scarcity/scarcity-phrase", 6)],
      directives,
    );
    expect(kept).toEqual([]);
    expect(applied).toEqual([
      { ruleId: "scarcity/scarcity-phrase", reason: "deliberate", line: 5 },
    ]);
  });

  it("does not reach past the next line", () => {
    // Not "the next finding": that would skip blank lines and comments and quietly cover something
    // further down that nobody meant to accept.
    const { kept, applied } = applySuppressionDirectives(
      [finding("scarcity/scarcity-phrase", 7)],
      directives,
    );
    expect(kept).toHaveLength(1);
    expect(applied).toEqual([]);
  });

  it("only suppresses the rule it names", () => {
    const { kept } = applySuppressionDirectives(
      [finding("consent/checked-checkbox", 6)],
      directives,
    );
    expect(kept).toHaveLength(1);
  });

  it("cannot reach a finding with no source line", () => {
    const { kept } = applySuppressionDirectives(
      [finding("scarcity/scarcity-phrase", undefined)],
      directives,
    );
    expect(kept).toHaveLength(1);
  });

  it("reports a directive that matched nothing", () => {
    // The same signal the file-based form reports for an unmatched entry: a suppression covering a
    // finding that no longer exists is one nobody will otherwise remove.
    const { unused } = applySuppressionDirectives([], directives);
    expect(unused).toEqual(directives);
  });

  it("counts one directive once, however many findings share the line", () => {
    const { kept, applied, unused } = applySuppressionDirectives(
      [finding("scarcity/scarcity-phrase", 6), finding("scarcity/scarcity-phrase", 6)],
      directives,
    );
    expect(kept).toEqual([]);
    expect(applied).toHaveLength(2);
    expect(unused).toEqual([]);
  });
});
