import { RUNTIME_CAPABILITIES, resolveDocumentCapabilities } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { parseSource } from "../src/index.js";

const source = `export function Banner() {
  return (
    <div className="banner" style={{ opacity: 0.6 }}>
      <button className="btn-primary" data-action="accept">Accept all</button>
      <input type="checkbox" checked={isOn} />
    </div>
  );
}`;

const doc = parseSource(source, { file: "Banner.tsx" });
const nodes = doc.all();

/**
 * The JSX/TSX row of `RUNTIME_CAPABILITIES`, checked against a document this adapter produced.
 *
 * The row is the same as static HTML's, and the reason is worth stating: this adapter reads source
 * it cannot evaluate, and it declines to assert a value it does not know rather than guessing one.
 * That is a confidence ceiling on findings, not a missing capability — the attribute is readable,
 * and its value is sometimes unknown.
 */
describe("what the AST adapter supplies", () => {
  it("resolves to the JSX/TSX baseline", () => {
    expect(doc.capabilities).toBeUndefined();
    expect(resolveDocumentCapabilities(doc)).toEqual(RUNTIME_CAPABILITIES.ast);
  });

  it("backs `structure` and `text`", () => {
    const root = doc.root;
    expect(root.children.map((child) => child.tag)).toEqual(["button", "input"]);
    expect(nodes.find((node) => node.tag === "button")?.normalizedText).toBe("accept all");
  });

  it("backs `attributes`, with JSX spellings normalized to the ones rules read", () => {
    const button = nodes.find((node) => node.tag === "button");
    expect(button?.attributes["data-action"]).toBe("accept");
    expect(button?.attributes.class).toBe("btn-primary");
  });

  it("backs `source-location`: a file, a line, and a column", () => {
    expect(RUNTIME_CAPABILITIES.ast).toContain("source-location");
    const button = nodes.find((node) => node.tag === "button");
    expect(button?.source?.file).toBe("Banner.tsx");
    expect(typeof button?.source?.startLine).toBe("number");
    expect(typeof button?.source?.startColumn).toBe("number");
  });

  it("backs `style-hints`: `className` reaches the model as a class name", () => {
    expect(RUNTIME_CAPABILITIES.ast).toContain("style-hints");
    expect(doc.root.attributes.class).toBe("banner");
  });

  it("claims no `dom-state`: an expression value is unknown, not a state that was read", () => {
    expect(RUNTIME_CAPABILITIES.ast).not.toContain("dom-state");
    const checkbox = nodes.find((node) => node.tag === "input");
    expect(checkbox?.attributes.checked).toBeUndefined();
  });
});
