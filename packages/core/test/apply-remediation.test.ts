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
    const result = apply([remediation({ id: "first" }), remediation({ id: "second" })]);
    expect(result.applied).toEqual(["first"]);
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
