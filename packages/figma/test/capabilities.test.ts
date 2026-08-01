import { RUNTIME_CAPABILITIES, resolveDocumentCapabilities } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { parseFigma } from "../src/index.js";

const json = JSON.stringify({
  name: "Consent Design",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:1",
        name: "Checkbox/Marketing",
        type: "COMPONENT",
        componentProperties: { "Checked#0:1": { type: "BOOLEAN", value: true } },
        children: [
          {
            id: "1:2",
            name: "Label",
            type: "TEXT",
            characters: "I agree to receive marketing emails",
          },
        ],
      },
    ],
  },
});

const doc = parseFigma(json, { file: "design.figma.json" });

/**
 * The Figma row of `RUNTIME_CAPABILITIES`, checked against a document this adapter produced.
 *
 * It is the shortest row, and the two absences are why: a Figma document has no source lines and no
 * class names or inline styles, so nothing in the model backs `style-hints` however visual the
 * source file looks.
 */
describe("what the Figma adapter supplies", () => {
  it("resolves to the Figma baseline", () => {
    expect(doc.capabilities).toBeUndefined();
    expect(resolveDocumentCapabilities(doc)).toEqual(RUNTIME_CAPABILITIES.figma);
  });

  it("backs `structure` and `text`", () => {
    const component = doc.root.children[0];
    expect(component?.children.map((child) => child.tag)).toEqual(["span"]);
    expect(component?.normalizedText).toBe("i agree to receive marketing emails");
  });

  it("backs `attributes`: the ones this adapter derives from node properties", () => {
    const component = doc.root.children[0];
    expect(component?.attributes.type).toBe("checkbox");
    expect(component?.attributes.checked).toBe(true);
  });

  it("claims no `style-hints`, and supplies nothing that would back one", () => {
    expect(RUNTIME_CAPABILITIES.figma).not.toContain("style-hints");
    for (const node of doc.all()) {
      expect(node.attributes.class).toBeUndefined();
      expect(node.attributes.style).toBeUndefined();
    }
  });

  it("claims no `source-location`, and supplies none", () => {
    expect(RUNTIME_CAPABILITIES.figma).not.toContain("source-location");
    expect(doc.all().every((node) => node.source === undefined)).toBe(true);
  });
});
