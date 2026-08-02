import { describe, expect, it } from "vitest";
import type { SourceSpan, UiNode } from "../src/index.js";
import { applyRemediations, removeAttributeEdit } from "../src/index.js";

const FILE = ["<main>", '  <input type="checkbox" checked>', "</main>"].join("\n");

/** ` checked` on line 2: the whitespace is part of the range, so removing it leaves no stray space. */
const CHECKED: SourceSpan = {
  startLine: 2,
  startColumn: 25,
  endLine: 2,
  endColumn: 33,
  text: " checked",
};

function node(over: Partial<UiNode> = {}): UiNode {
  return {
    id: "0.0",
    tag: "input",
    attributes: { type: "checkbox", checked: true },
    directText: "",
    subtreeText: "",
    normalizedText: "",
    children: [],
    locator: { type: "css", value: "input" },
    source: { file: "page.html", startLine: 2, startColumn: 3 },
    attributeRanges: { checked: CHECKED },
    ...over,
  };
}

describe("removeAttributeEdit", () => {
  it("builds the edit from the node alone, with no filesystem in reach", () => {
    expect(removeAttributeEdit(node(), "checked")).toEqual({
      startLine: 2,
      startColumn: 25,
      endLine: 2,
      endColumn: 33,
      expected: " checked",
      replacement: "",
    });
  });

  it("produces an edit the applier accepts, rather than one that only looks right", () => {
    const edit = removeAttributeEdit(node(), "checked");
    expect(edit).toBeDefined();
    const applied = applyRemediations(
      FILE,
      [
        {
          id: "r1",
          origin: "rule",
          safety: "safe",
          title: "Remove the checked attribute",
          description: "Removes ` checked` from the input.",
          rationale: "One attribute is removed and no text a user reads changes.",
          file: "page.html",
          fileChecksum: "a".repeat(64),
          edits: [edit as NonNullable<typeof edit>],
        },
      ],
      { actualChecksum: "a".repeat(64) },
    );

    expect(applied.refused).toEqual([]);
    expect(applied.contents).toBe(["<main>", '  <input type="checkbox">', "</main>"].join("\n"));
  });

  it("returns undefined for an attribute the node carries no range for", () => {
    expect(removeAttributeEdit(node(), "type")).toBeUndefined();
  });

  it("returns undefined when nothing recorded ranges at all", () => {
    expect(removeAttributeEdit(node({ attributeRanges: undefined }), "checked")).toBeUndefined();
  });

  it("does not invent a range from the node's own start position", () => {
    // The node knows where the *element* starts. A helper that fell back to it would produce an
    // edit pointing at `<input`, which `expected` would catch — after the applier had been handed
    // a fix nobody could have written correctly.
    const withoutRanges = node({ attributeRanges: undefined });
    expect(withoutRanges.source?.startLine).toBe(2);
    expect(removeAttributeEdit(withoutRanges, "checked")).toBeUndefined();
  });
});
