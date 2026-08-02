import type { UiNode } from "@fairux/core";
import {
  RUNTIME_CAPABILITIES,
  removeAttributeEdit,
  resolveDocumentCapabilities,
  sortCapabilityIds,
} from "@fairux/core";
import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/index.js";

const page = ["<main>", '  <input type="checkbox" checked>', "</main>"].join("\n");

function inputOf(html: string, sourceRanges = true): UiNode {
  const nodes = parseHtml(html, { file: "page.html", sourceRanges }).all();
  const input = nodes.find((node) => node.tag === "input");
  if (!input) throw new Error("fixture has no input");
  return input;
}

describe("attribute source ranges", () => {
  it("is off by default, and the document does not claim what it did not keep", () => {
    const doc = parseHtml(page, { file: "page.html" });
    expect(doc.capabilities).toBeUndefined();
    expect(resolveDocumentCapabilities(doc)).toEqual(RUNTIME_CAPABILITIES.html);
    expect(inputOf(page, false).attributeRanges).toBeUndefined();
  });

  it("claims `source-range` on top of the static-HTML baseline when asked", () => {
    const doc = parseHtml(page, { file: "page.html", sourceRanges: true });
    expect(resolveDocumentCapabilities(doc)).toEqual(
      sortCapabilityIds([...RUNTIME_CAPABILITIES.html, "source-range"]),
    );
    // In vocabulary order, beside the location capability it extends — not appended to the end.
    expect(resolveDocumentCapabilities(doc)).toEqual([
      "structure",
      "text",
      "attributes",
      "source-location",
      "source-range",
      "style-hints",
    ]);
  });

  it("claims it for a document with nothing in it, rather than only for a lucky one", () => {
    const doc = parseHtml("", { sourceRanges: true });
    expect(resolveDocumentCapabilities(doc)).toContain("source-range");
  });

  it("covers the attribute and the whitespace before it", () => {
    // `  <input type="checkbox" checked>` — ` checked` runs from column 25 up to, not including, 33.
    expect(inputOf(page).attributeRanges?.checked).toEqual({
      startLine: 2,
      startColumn: 25,
      endLine: 2,
      endColumn: 33,
      text: " checked",
    });
  });

  it("records a range for every attribute the node carries", () => {
    const input = inputOf(page);
    expect(Object.keys(input.attributeRanges ?? {})).toEqual(Object.keys(input.attributes));
    expect(input.attributeRanges?.type?.text).toBe(' type="checkbox"');
  });

  it("measures the column from the right line when the whitespace is a newline", () => {
    const wrapped = [
      "<main>",
      "  <input",
      '    type="checkbox"',
      "    checked",
      "  >",
      "</main>",
    ].join("\n");
    expect(inputOf(wrapped).attributeRanges?.checked).toEqual({
      startLine: 3,
      startColumn: 20,
      endLine: 4,
      endColumn: 12,
      text: "\n    checked",
    });
  });

  it("produces text the source actually holds, for every attribute of every element", () => {
    // The property that makes the ranges usable: `text` is what a `TextEdit.expected` must equal,
    // and an off-by-one anywhere in the arithmetic shows up here rather than in an applied fix.
    const html = [
      "<!doctype html>",
      '<html lang="en">',
      "<body>",
      '  <form action="/pay" novalidate><input name="q" value="a b" required></form>',
      '  <button class="x"',
      '          data-role="accept" disabled>Accept</button>',
      "</body>",
      "</html>",
    ].join("\n");
    const lines = html.split("\n");

    let checked = 0;
    for (const node of parseHtml(html, { sourceRanges: true }).all()) {
      for (const [name, span] of Object.entries(node.attributeRanges ?? {})) {
        const sliced = lines
          .slice(span.startLine - 1, span.endLine)
          .join("\n")
          .slice(span.startColumn - 1);
        expect(sliced.startsWith(span.text), `${node.tag}[${name}]`).toBe(true);
        expect(span.text.trimStart()).toBe(span.text.trim());
        checked += 1;
      }
    }
    expect(checked).toBe(9);
  });

  it("costs enough to be worth declining, which is what the option is for", () => {
    // The size answer, measured rather than asserted. On an attribute-heavy page the retained model
    // is about 1.7× the size it is without ranges — the bound below is deliberately loose, because
    // what this pins is that the cost is real and visible, not a particular ratio.
    const rows = Array.from(
      { length: 500 },
      (_, index) =>
        `<li class="row" data-id="${index}" data-kind="item"><a href="/i/${index}" rel="nofollow">Item ${index}</a></li>`,
    );
    const html = `<ul>\n${rows.join("\n")}\n</ul>`;
    const plain = JSON.stringify(parseHtml(html, { file: "p.html" }).root).length;
    const ranged = JSON.stringify(
      parseHtml(html, { file: "p.html", sourceRanges: true }).root,
    ).length;

    expect(ranged / plain).toBeGreaterThan(1.5);
    expect(ranged / plain).toBeLessThan(2);
  });

  it("gives a rule with no filesystem the edit an external pack had to read the file for", () => {
    const edit = removeAttributeEdit(inputOf(page), "checked");
    expect(edit).toEqual({
      startLine: 2,
      startColumn: 25,
      endLine: 2,
      endColumn: 33,
      expected: " checked",
      replacement: "",
    });
  });
});
