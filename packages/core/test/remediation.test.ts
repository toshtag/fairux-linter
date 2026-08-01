import { describe, expect, it } from "vitest";
import type { Remediation, Rule, RuleMeta } from "../src/index.js";
import { RulePackError, scan } from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const CHECKSUM = "a".repeat(64);

const meta: RuleMeta = {
  id: "test/fixable",
  title: "Fixable",
  category: "consent",
  defaultSeverity: "medium",
  defaultConfidence: "high",
  defaultEnabled: true,
  tags: [],
  version: "1.0.0",
  maturity: "stable",
  requiredCapabilities: ["structure"],
  evidenceRequirements: ["presence"],
};

function remediation(over: Partial<Remediation> = {}): Remediation {
  return {
    id: "test/fixable#0",
    origin: "rule",
    safety: "safe",
    title: "Uncheck the box",
    description: "Removes the checked attribute from the marketing consent checkbox.",
    rationale: "The attribute is removed and nothing a user reads changes.",
    file: "page.html",
    fileChecksum: CHECKSUM,
    edits: [
      {
        startLine: 3,
        startColumn: 10,
        endLine: 3,
        endColumn: 18,
        expected: " checked",
        replacement: "",
      },
    ],
    ...over,
  } as Remediation;
}

function ruleProducing(value: unknown): Rule {
  return {
    meta,
    evaluate(_doc, ctx) {
      return [
        ctx.createFinding({
          evidence: [{ text: "Email me offers" }],
          description: "d",
          whyItMatters: "w",
          recommendation: "r",
          remediation: value as never,
        }),
      ];
    },
  };
}

const doc = makeDoc({ tag: "div", children: [{ tag: "input" }] });
const run = (value: unknown) => scan(doc, [ruleProducing(value)]);

describe("a remediation a rule attached", () => {
  it("reaches the finding, frozen", () => {
    const finding = run(remediation()).findings[0];
    expect(finding?.remediation?.id).toBe("test/fixable#0");
    expect(finding?.remediation?.safety).toBe("safe");
    expect(Object.isFrozen(finding?.remediation)).toBe(true);
    expect(Object.isFrozen(finding?.remediation?.edits[0])).toBe(true);
  });

  it("is absent on a finding that offers none, and that is not a defect", () => {
    const plain: Rule = {
      meta,
      evaluate(_d, ctx) {
        return [
          ctx.createFinding({
            evidence: [{ text: "x" }],
            description: "d",
            whyItMatters: "w",
            recommendation: "r",
          }),
        ];
      },
    };
    expect(scan(doc, [plain]).findings[0]?.remediation).toBeUndefined();
  });
});

describe("the boundary that exists before the thing it gates", () => {
  it("refuses a safe remediation that came from an AI", () => {
    // M6 adds AI augmentation. This is what makes "AI-generated edits are never auto-applied" a
    // validation rule rather than a promise in a document.
    expect(() => run(remediation({ origin: "ai", safety: "safe" }))).toThrow(RulePackError);
  });

  it("accepts an AI remediation that admits it needs review", () => {
    const finding = run(remediation({ origin: "ai", safety: "review-required" })).findings[0];
    expect(finding?.remediation?.origin).toBe("ai");
    expect(finding?.remediation?.safety).toBe("review-required");
  });

  it("refuses an unknown origin or safety rather than passing it through", () => {
    expect(() => run(remediation({ origin: "human" as never }))).toThrow(RulePackError);
    expect(() => run(remediation({ safety: "probably-fine" as never }))).toThrow(RulePackError);
  });
});

describe("an edit that could be applied to the wrong bytes", () => {
  it("refuses a checksum that was not computed the documented way", () => {
    expect(() => run(remediation({ fileChecksum: "not-a-hash" }))).toThrow(RulePackError);
    expect(() => run(remediation({ fileChecksum: CHECKSUM.toUpperCase() }))).toThrow(RulePackError);
  });

  it("refuses an edit with no `expected` text", () => {
    // A range alone is a bet that nothing moved between the scan and the write, and that bet is
    // lost quietly: the edit lands somewhere plausible and nothing reports it.
    const noExpected = remediation({
      edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, replacement: "" }] as never,
    });
    expect(() => run(noExpected)).toThrow(RulePackError);
  });

  it("accepts an empty `expected`, which is an insertion", () => {
    const insertion = remediation({
      edits: [
        {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
          expected: "",
          replacement: "<!-- added -->",
        },
      ],
    });
    expect(run(insertion).findings[0]?.remediation?.edits[0]?.expected).toBe("");
  });

  it("refuses a range that ends before it starts", () => {
    const backwards = remediation({
      edits: [
        {
          startLine: 5,
          startColumn: 3,
          endLine: 4,
          endColumn: 9,
          expected: "x",
          replacement: "",
        },
      ],
    });
    expect(() => run(backwards)).toThrow(RulePackError);
  });

  it("refuses zero edits, and a non-integer or zero position", () => {
    expect(() => run(remediation({ edits: [] as never }))).toThrow(RulePackError);
    expect(() =>
      run(
        remediation({
          edits: [
            {
              startLine: 0,
              startColumn: 1,
              endLine: 1,
              endColumn: 1,
              expected: "",
              replacement: "",
            },
          ],
        }),
      ),
    ).toThrow(RulePackError);
  });
});

describe("the fields a reviewer reads", () => {
  it("requires a rationale, for a cautious remediation and a safe one alike", () => {
    // A `safe` classification needs an argument more than a cautious one does.
    expect(() => run(remediation({ rationale: "" as never }))).toThrow(RulePackError);
    expect(() => run(remediation({ rationale: undefined as never }))).toThrow(RulePackError);
  });

  it("refuses an unknown field rather than dropping it", () => {
    expect(() => run({ ...remediation(), autoApply: true })).toThrow(RulePackError);
  });

  it("requires the file the edits apply to", () => {
    expect(() => run(remediation({ file: undefined as never }))).toThrow(RulePackError);
  });
});
