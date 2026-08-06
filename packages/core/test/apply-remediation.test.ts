import { describe, expect, it } from "vitest";
import type { Remediation, TextEdit } from "../src/index.js";
import { applyRemediations } from "../src/index.js";

const CHECKSUM = "b".repeat(64);
const FILE = [
  "<main>",
  '  <input type="checkbox" checked>',
  "  <p>Only 2 left!</p>",
  "</main>",
].join("\n");

function edit(over: Partial<TextEdit> = {}): TextEdit {
  return {
    // ` checked` on line 2, columns 25–33.
    startLine: 2,
    startColumn: 25,
    endLine: 2,
    endColumn: 33,
    expected: " checked",
    replacement: "",
    ...over,
  };
}

function remediation(over: Partial<Remediation> = {}): Remediation {
  return {
    id: "r1",
    origin: "rule",
    safety: "safe",
    title: "Uncheck",
    description: "d",
    rationale: "why",
    file: "page.html",
    fileChecksum: CHECKSUM,
    edits: [edit()],
    ...over,
  } as Remediation;
}

const apply = (remediations: readonly Remediation[], actualChecksum = CHECKSUM) =>
  applyRemediations(FILE, remediations, { actualChecksum });

describe("what applying does when it works", () => {
  it("replaces exactly the range the edit named", () => {
    const result = apply([remediation()]);
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual(["r1"]);
    expect(result.refused).toEqual([]);
    expect(result.contents).toContain('<input type="checkbox">');
    // Nothing else moved.
    expect(result.contents).toContain("Only 2 left!");
    expect(result.contents.split("\n")).toHaveLength(4);
  });

  it("applies several edits right to left, so earlier offsets stay valid", () => {
    const two = remediation({
      edits: [
        edit(),
        {
          startLine: 3,
          startColumn: 6,
          endLine: 3,
          endColumn: 18,
          expected: "Only 2 left!",
          replacement: "In stock.",
        },
      ],
    });
    const result = apply([two]);
    expect(result.contents).toContain('<input type="checkbox">');
    expect(result.contents).toContain("In stock.");
  });

  it("inserts where a range is empty", () => {
    const insertion = remediation({
      edits: [
        {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
          expected: "",
          replacement: "<!-- reviewed -->\n",
        },
      ],
    });
    expect(apply([insertion]).contents.startsWith("<!-- reviewed -->\n<main>")).toBe(true);
  });

  it("leaves the contents alone when there is nothing to apply", () => {
    const result = apply([]);
    expect(result.changed).toBe(false);
    expect(result.contents).toBe(FILE);
  });
});

describe("every refusal, and the file it protects", () => {
  it("refuses a review-required remediation, whatever else is true of it", () => {
    const result = apply([remediation({ safety: "review-required" })]);
    expect(result.applied).toEqual([]);
    expect(result.refused[0]?.code).toBe("review-required");
    expect(result.contents).toBe(FILE);
  });

  it("refuses an AI-origin remediation, and names it as that rather than as unsafe", () => {
    // Validation already refuses a `safe` AI remediation, so reaching here means something built one
    // outside that path. It is still not applied, and the reason says what it actually was.
    const result = apply([remediation({ origin: "ai", safety: "safe" })]);
    expect(result.refused[0]?.code).toBe("ai-origin");
    expect(result.contents).toBe(FILE);
  });

  it("refuses when the file changed since the scan", () => {
    const result = apply([remediation()], "c".repeat(64));
    expect(result.refused[0]?.code).toBe("file-changed");
    expect(result.contents).toBe(FILE);
  });

  it("refuses a range that points outside the file", () => {
    const result = apply([
      remediation({ edits: [edit({ startLine: 99, endLine: 99, endColumn: 33 })] }),
    ]);
    expect(result.refused[0]?.code).toBe("range-outside-file");
    expect(result.contents).toBe(FILE);
  });

  it("refuses when the text at the range is not what the edit expected", () => {
    // The range is real and the file is the one it was computed for; something else moved the text.
    // Applying anyway lands the edit somewhere plausible and nothing reports it.
    const result = apply([remediation({ edits: [edit({ expected: " disabled" })] })]);
    expect(result.refused[0]?.code).toBe("expected-mismatch");
    expect(result.contents).toBe(FILE);
  });

  it("refuses two edits that cover the same characters", () => {
    const overlapping = remediation({
      // Columns 20–33 of line 2 are `kbox" checked`, which covers the ` checked` the first edit
      // already claims.
      edits: [edit(), edit({ startColumn: 20, expected: 'kbox" checked', replacement: "" })],
    });
    const result = apply([overlapping]);
    expect(result.refused[0]?.code).toBe("overlapping-edits");
    expect(result.contents).toBe(FILE);
  });

  it("applies none of a remediation when one of its edits is refused", () => {
    // A partially applied fix leaves the file in a state neither the author nor the tool intended.
    const partly = remediation({
      edits: [edit(), edit({ startLine: 99, endLine: 99, expected: "nope" })],
    });
    const result = apply([partly]);
    expect(result.applied).toEqual([]);
    expect(result.contents).toBe(FILE);
  });
});

describe("several remediations over one file", () => {
  it("applies what it can and refuses the rest, in one pass", () => {
    const result = apply([
      remediation({ id: "ok" }),
      remediation({ id: "needs-review", safety: "review-required" }),
    ]);
    expect(result.applied).toEqual(["ok"]);
    expect(result.refused.map((entry) => entry.remediationId)).toEqual(["needs-review"]);
    expect(result.changed).toBe(true);
  });

  it("refuses a second remediation whose text the first one rewrote", () => {
    // Each is checked against the contents as they stand, so a stale expectation cannot land on
    // different bytes. Which refusal it earns depends on how the first edit moved the file — here
    // the line got shorter, so the range no longer exists; had it stayed long enough, the text at it
    // would not match. Both are the same protection.
    //
    // The two edits are deliberately *different*. Two remediations asking for the identical edit is
    // the one case this is not about, and it is coalesced rather than refused — see "two
    // remediations asking for the same edit" below.
    const second = remediation({
      id: "second",
      edits: [edit({ startColumn: 26, endColumn: 33, expected: "checked", replacement: "x" })],
    });
    const result = apply([remediation({ id: "first" }), second]);
    expect(result.applied).toEqual(["first"]);
    expect(result.coalesced).toEqual([]);
    expect(["range-outside-file", "expected-mismatch"]).toContain(result.refused[0]?.code);
  });

  it("does not let an applied fix make a stale remediation fresh", () => {
    // The checksum is compared against the file as it was passed in. A remediation computed for
    // other bytes stays refused however many valid ones ran before it.
    const result = apply([
      remediation({ id: "ok" }),
      remediation({ id: "stale", fileChecksum: "d".repeat(64) }),
    ]);
    expect(result.applied).toEqual(["ok"]);
    expect(result.refused[0]?.code).toBe("file-changed");
  });
});

/**
 * Two rules asking for the same edit.
 *
 * Not a hypothetical: `consent/checked-checkbox` removes a pre-checked `checked`, and a RulePack
 * under a different rule id can reach the same conclusion about the same attribute. The first edit
 * landed, the second was resolved against text the first had already replaced, and was refused as
 * `expected-mismatch` — so `--fix-write` exited 1 on a file that was exactly what was asked for,
 * and said the tree was partly fixed.
 *
 * The refusal code was doing two jobs. It protects a genuinely stale or conflicting edit, and it
 * must go on doing that; what it must not do is report a second rule agreeing with the first as a
 * failure. Identical edits are coalesced instead: one physical edit, both remediations accounted
 * for, and the comparison is between what the two asked for rather than between one of them and the
 * file as it now stands.
 */
describe("two remediations asking for the same edit", () => {
  const second = remediation({ id: "r2" });

  it("makes one physical edit and accounts for both", () => {
    const result = apply([remediation(), second]);

    expect(result.applied).toEqual(["r1"]);
    expect(result.coalesced).toEqual([{ remediationId: "r2", satisfiedBy: "r1" }]);
    expect(result.refused).toEqual([]);
    // Once, not twice: the second edit would have taken eight more characters with it.
    expect(result.contents).toContain('<input type="checkbox">');
    expect(result.contents).toBe(FILE.replace(" checked", ""));
  });

  it("names the first satisfier when two earlier remediations covered one edit each", () => {
    // Reachable only from a hand-built multi-edit remediation — every one this repository produces
    // carries a single edit — and pinned so the single name is a choice rather than an accident.
    // Both satisfiers were applied, so both are accounted for on their own.
    const other = edit({ startLine: 3, endLine: 3, startColumn: 3, endColumn: 6, expected: "<p>" });
    const both = remediation({ id: "r3", edits: [edit(), other] });
    const result = apply([
      remediation({ id: "r1" }),
      remediation({ id: "r2", edits: [other] }),
      both,
    ]);

    expect(result.applied).toEqual(["r1", "r2"]);
    expect(result.coalesced).toEqual([{ remediationId: "r3", satisfiedBy: "r1" }]);
  });

  it("attributes it to the remediation that actually made the edit", () => {
    const third = remediation({ id: "r3" });
    const result = apply([remediation(), second, third]);
    expect(result.applied).toEqual(["r1"]);
    expect(result.coalesced.map((entry) => entry.satisfiedBy)).toEqual(["r1", "r1"]);
  });

  it("coalesces regardless of which rule produced it, as long as the edit is the same", () => {
    // The whole point: the two come from different rules, and neither is privileged.
    const result = apply([
      remediation({ id: "fixtures/pre-checked-box#3" }),
      remediation({ id: "consent/checked-checkbox:remove-checked:0.1" }),
    ]);
    expect(result.applied).toEqual(["fixtures/pre-checked-box#3"]);
    expect(result.coalesced).toEqual([
      {
        remediationId: "consent/checked-checkbox:remove-checked:0.1",
        satisfiedBy: "fixtures/pre-checked-box#3",
      },
    ]);
  });

  it("does not coalesce with a remediation that was refused rather than applied", () => {
    // Nothing happened to the file, so the second is judged on its own — and here it applies.
    const stale = remediation({ id: "stale", fileChecksum: "c".repeat(64) });
    const result = apply([stale, second]);
    expect(result.refused.map((r) => r.code)).toEqual(["file-changed"]);
    expect(result.coalesced).toEqual([]);
    expect(result.applied).toEqual(["r2"]);
  });
});

describe("what is not the same edit", () => {
  /**
   * Each of these is a way two remediations can look alike and mean different things. None is
   * coalesced, all stay refusals, and the file keeps whatever the first one did to it — which is
   * what makes a second, disagreeing rule a failure a caller has to look at.
   */
  it("refuses the same range with a different replacement", () => {
    const other = remediation({ id: "r2", edits: [edit({ replacement: " data-was-checked" })] });
    const result = apply([remediation(), other]);
    expect(result.coalesced).toEqual([]);
    expect(result.refused.map((r) => r.remediationId)).toEqual(["r2"]);
    expect(result.contents).not.toContain("data-was-checked");
  });

  it("refuses a partial overlap", () => {
    const overlapping = remediation({
      id: "r2",
      edits: [edit({ startColumn: 25, endColumn: 30, expected: " chec" })],
    });
    const result = apply([remediation(), overlapping]);
    expect(result.coalesced).toEqual([]);
    expect(result.refused.map((r) => r.remediationId)).toEqual(["r2"]);
  });

  it("refuses the same coordinates with different expected text", () => {
    // Same range, same replacement, but the two disagree about what is there — so at most one of
    // them was computed against these bytes, and a match on the rest is not evidence. Which refusal
    // it earns depends on how the first edit moved the file; both are the same protection.
    const other = remediation({ id: "r2", edits: [edit({ expected: " CHECKED" })] });
    const result = apply([remediation(), other]);
    expect(result.coalesced).toEqual([]);
    expect(["range-outside-file", "expected-mismatch"]).toContain(result.refused[0]?.code);
    expect(result.refused.map((r) => r.remediationId)).toEqual(["r2"]);
  });

  it("refuses a different checksum, identical edit or not", () => {
    // Held twice over, deliberately. The checksum is compared against the contents before anything
    // is coalesced, *and* it is part of what makes two edits the same edit — so a stale remediation
    // whose coordinates, expected text, and replacement all match an applied one is still refused.
    // Removing either guard alone leaves the other holding; removing both coalesces it.
    const other = remediation({ id: "r2", fileChecksum: "c".repeat(64) });
    const result = apply([remediation(), other]);
    expect(result.coalesced).toEqual([]);
    expect(result.refused.map((r) => r.code)).toEqual(["file-changed"]);
  });

  it("refuses a different file, identical coordinates or not", () => {
    const other = remediation({ id: "r2", file: "other.html" });
    const result = apply([remediation(), other]);
    expect(result.coalesced).toEqual([]);
    expect(result.refused.map((r) => r.remediationId)).toEqual(["r2"]);
  });

  it("refuses a remediation only half of which an earlier one made", () => {
    // One of its two edits is identical to the applied one; the other is new. Half-satisfied is not
    // satisfied, and applying the rest would put the new edit through a range whose text has moved.
    const half = remediation({
      id: "r2",
      edits: [
        edit(),
        edit({ startLine: 3, endLine: 3, startColumn: 3, endColumn: 6, expected: "<p>" }),
      ],
    });
    const result = apply([remediation(), half]);
    expect(result.coalesced).toEqual([]);
    expect(result.refused.map((r) => r.remediationId)).toEqual(["r2"]);
    expect(result.contents).toContain("<p>Only 2 left!</p>");
  });

  it("never coalesces a review-required or an AI-origin remediation", () => {
    // Both are boundaries rather than accounting, and an identical edit landing first must not be a
    // way around either.
    const needsReview = remediation({ id: "r2", safety: "review-required" });
    const fromAi = remediation({ id: "r3", origin: "ai", safety: "review-required" });
    const result = apply([remediation(), needsReview, fromAi]);
    expect(result.coalesced).toEqual([]);
    expect(result.refused.map((r) => r.code)).toEqual(["review-required", "ai-origin"]);
  });
});

/**
 * A remediation that contradicts itself, and the order that used to hide it.
 *
 * Coalescing matches a remediation's edits against edits an earlier one already made. Two identical
 * edits inside *one* remediation collapse to a single key, so a remediation nobody could have
 * applied matched on it and was reported as already satisfied — never resolved, never checked, and
 * counted as accounted for. A self-overlapping remediation went the same way whenever the overlap
 * fell inside a range somebody else had written.
 *
 * The check is now asked before coalescing, from the positions alone. Both answers are properties of
 * the remediation rather than of the file: it is wrong against every file, including one it could
 * never be resolved against.
 */
describe("a remediation that contradicts itself", () => {
  it("refuses two edits that are the same edit", () => {
    const twice = remediation({ edits: [edit(), edit()] });
    const result = apply([twice]);
    expect(result.refused[0]?.code).toBe("duplicate-edits");
    expect(result.applied).toEqual([]);
    expect(result.contents).toBe(FILE);
  });

  it("refuses it even when an earlier remediation made that edit", () => {
    // The case coalescing hid. `r2` asks for the same edit twice; one earlier remediation made it
    // once, so every key matched and `r2` was waved through as satisfied.
    const twice = remediation({ id: "r2", edits: [edit(), edit()] });
    const result = apply([remediation(), twice]);
    expect(result.applied).toEqual(["r1"]);
    expect(result.coalesced).toEqual([]);
    expect(result.refused.map((r) => [r.remediationId, r.code])).toEqual([
      ["r2", "duplicate-edits"],
    ]);
  });

  it("refuses self-overlapping edits even when an earlier remediation covered part of them", () => {
    const overlapping = remediation({
      id: "r2",
      edits: [edit(), edit({ startColumn: 20, expected: 'kbox" checked', replacement: "" })],
    });
    const result = apply([remediation(), overlapping]);
    expect(result.coalesced).toEqual([]);
    expect(result.refused.map((r) => r.code)).toEqual(["overlapping-edits"]);
  });

  it("still coalesces a remediation whose edits are distinct", () => {
    // The behaviour the new check must not break: two rules reaching the same conclusion is not a
    // contradiction, and coalescing is why `--fix-write` does not exit 1 on a correct tree.
    const same = remediation({ id: "r2" });
    const result = apply([remediation(), same]);
    expect(result.coalesced).toEqual([{ remediationId: "r2", satisfiedBy: "r1" }]);
    expect(result.refused).toEqual([]);
  });

  it("leaves an inverted range to the check that names it correctly", () => {
    // An edit whose own end precedes its own start is `range-outside-file`. Sorting such a span
    // would make it look like an overlap, and a reader would be told the wrong thing about it.
    const inverted = remediation({
      edits: [edit({ startLine: 3, startColumn: 6, endLine: 2, endColumn: 25 })],
    });
    expect(apply([inverted]).refused[0]?.code).toBe("range-outside-file");
  });
});
