import { InputTooLargeError, MAX_INPUT_BYTES, MAX_NODE_COUNT, scan } from "@fairux/core";
import { allRules, dictionary } from "@fairux/rules";
import { describe, expect, it } from "vitest";
import { parseFigma } from "../src/index.js";

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Realistic Figma REST API JSON fixtures using actual node types:
 * COMPONENT, INSTANCE, FRAME, TEXT, CANVAS, DOCUMENT.
 * No fictional BUTTON/CHECKBOX/INPUT types — those don't exist in the REST API.
 */

const REALISTIC_FIGMA = JSON.stringify({
  document: {
    id: "0:0",
    name: "Page",
    type: "CANVAS",
    children: [
      {
        id: "1:1",
        name: "Button/Buy",
        type: "COMPONENT",
        componentPropertyDefinitions: {
          Label: { type: "TEXT", defaultValue: "Buy now" },
        },
        children: [
          {
            id: "1:2",
            name: "Label",
            type: "TEXT",
            characters: "Buy now",
          },
        ],
      },
      {
        id: "1:3",
        name: "Checkbox/Agree",
        type: "COMPONENT",
        componentPropertyDefinitions: {
          Checked: { type: "BOOLEAN", defaultValue: false },
        },
      },
      {
        id: "1:4",
        name: "Button/Submit Instance",
        type: "INSTANCE",
        componentProperties: {
          Label: { type: "TEXT", value: "Submit" },
        },
      },
      {
        id: "1:5",
        name: "Generic Frame",
        type: "FRAME",
      },
    ],
  },
  name: "Test File",
});

describe("parseFigma", () => {
  it("parses a realistic Figma JSON into a UiDocument", () => {
    const doc = parseFigma(REALISTIC_FIGMA);
    expect(doc.runtime).toBe("figma");
    expect(doc.root.tag).toBe("div");
    expect(doc.root.children.length).toBe(4);
  });

  it("infers button tag from COMPONENT named 'Button/Buy'", () => {
    const doc = parseFigma(REALISTIC_FIGMA);
    const btn = doc.root.children[0];
    expect(btn).toBeDefined();
    expect(btn?.tag).toBe("button");
    expect(btn?.locator).toEqual({ type: "figma", nodeId: "1:1" });
  });

  it("infers input with type=checkbox from COMPONENT with BOOLEAN 'Checked' property", () => {
    const doc = parseFigma(REALISTIC_FIGMA);
    const checkbox = doc.root.children[1];
    expect(checkbox).toBeDefined();
    expect(checkbox?.tag).toBe("input");
    expect(checkbox?.attributes.type).toBe("checkbox");
    expect(checkbox?.attributes.checked).toBeUndefined();
  });

  it("sets checked only when Checkbox has boolean Checked true", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Checkbox/Marketing",
            type: "COMPONENT",
            componentProperties: {
              "Checked#123:456": { type: "BOOLEAN", value: true },
            },
            children: [
              {
                id: "1:2",
                name: "Label",
                type: "TEXT",
                characters: "I agree to receive marketing emails",
              },
            ],
          },
          {
            id: "1:3",
            name: "Checkbox/Terms",
            type: "COMPONENT",
            componentProperties: {
              "Checked#123:457": { type: "BOOLEAN", value: false },
            },
          },
        ],
      },
    });
    const doc = parseFigma(json);
    expect(doc.root.children[0]?.attributes).toMatchObject({ type: "checkbox", checked: true });
    expect(doc.root.children[1]?.attributes).toMatchObject({ type: "checkbox" });
    expect(doc.root.children[1]?.attributes.checked).toBeUndefined();
  });

  it("detects a checked Figma checkbox through the consent rule", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Consent Page",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Checkbox/Marketing",
            type: "COMPONENT",
            componentProperties: {
              "Checked#0:1": { type: "BOOLEAN", value: true },
            },
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
      name: "Consent Design",
    });
    const report = scan(parseFigma(json), allRules, { dictionary, toolVersion: "test" });
    const finding = report.findings.find((f) => f.ruleId === "consent/checked-checkbox");
    expect(finding).toBeDefined();
    expect(["low", "medium"]).toContain(finding?.confidence);
  });

  it("infers button tag from INSTANCE named 'Button/Submit Instance'", () => {
    const doc = parseFigma(REALISTIC_FIGMA);
    const instance = doc.root.children[2];
    expect(instance).toBeDefined();
    expect(instance?.tag).toBe("button");
  });

  it("maps generic FRAME to div (no inference)", () => {
    const doc = parseFigma(REALISTIC_FIGMA);
    const frame = doc.root.children[3];
    expect(frame).toBeDefined();
    expect(frame?.tag).toBe("div");
  });

  it("extracts text content from TEXT nodes", () => {
    const doc = parseFigma(REALISTIC_FIGMA);
    const btn = doc.root.children[0];
    const label = btn?.children[0];
    expect(label?.tag).toBe("span");
    expect(label?.directText).toBe("Buy now");
    expect(label?.accessibility?.name).toBe("Buy now");
  });

  it("sets metadata from the Figma file", () => {
    const doc = parseFigma(REALISTIC_FIGMA, { file: "test-figma.json" });
    expect(doc.metadata?.file).toBe("test-figma.json");
    expect(doc.metadata?.title).toBe("Test File");
  });

  it("throws on empty JSON without document", () => {
    expect(() => parseFigma('{"name":"empty"}')).toThrow("no document node");
  });

  it("respects hidden visibility", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [{ id: "1:1", name: "Hidden", type: "FRAME", visible: false }],
      },
    });
    const doc = parseFigma(json);
    expect(doc.root.children[0]?.attributes.hidden).toBe(true);
  });

  it("maps COMPONENT without button/checkbox name to div", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [{ id: "1:1", name: "Card Container", type: "COMPONENT" }],
      },
    });
    const doc = parseFigma(json);
    expect(doc.root.children[0]?.tag).toBe("div");
  });

  it("Button with Show icon BOOLEAN property remains button (not input)", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Button/Primary",
            type: "COMPONENT",
            componentPropertyDefinitions: {
              "Show icon": { type: "BOOLEAN", defaultValue: false },
            },
          },
        ],
      },
    });
    const doc = parseFigma(json);
    const btn = doc.root.children[0];
    expect(btn?.tag).toBe("button");
    expect(btn?.tag).not.toBe("input");
  });

  it("does not infer inputs from generic BOOLEAN properties", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Card/Plan",
            type: "COMPONENT",
            componentPropertyDefinitions: {
              "Enabled#0:1": { type: "BOOLEAN", defaultValue: true },
            },
          },
          {
            id: "1:2",
            name: "Tab/Account",
            type: "COMPONENT",
            componentPropertyDefinitions: {
              "Selected#0:2": { type: "BOOLEAN", defaultValue: true },
            },
          },
          {
            id: "1:3",
            name: "Generic/Power",
            type: "COMPONENT",
            componentProperties: {
              On: { type: "BOOLEAN", value: true },
            },
          },
          {
            id: "1:4",
            name: "Card/Unchecked",
            type: "COMPONENT",
            componentProperties: {
              "UncheckedLabel#0:3": { type: "BOOLEAN", value: true },
            },
          },
          {
            id: "1:5",
            name: "Card/Prechecked",
            type: "COMPONENT",
            componentProperties: {
              "PrecheckedText#0:4": { type: "BOOLEAN", value: true },
            },
          },
        ],
      },
    });
    const doc = parseFigma(json);
    expect(doc.root.children.map((child) => child.tag)).toEqual([
      "div",
      "div",
      "div",
      "div",
      "div",
    ]);
  });

  it("infers radio input and maps selected state to checked", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Radio/Plan",
            type: "COMPONENT",
            componentPropertyDefinitions: {
              "Selected#123:456": { type: "BOOLEAN", defaultValue: true },
            },
          },
        ],
      },
    });
    const doc = parseFigma(json);
    expect(doc.root.children[0]?.tag).toBe("input");
    expect(doc.root.children[0]?.attributes.type).toBe("radio");
    expect(doc.root.children[0]?.attributes.checked).toBe(true);
  });

  it("infers checkbox from suffixed component property definitions", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Consent Control",
            type: "COMPONENT",
            componentPropertyDefinitions: {
              "Checked#0:1": { type: "BOOLEAN", defaultValue: true },
            },
          },
        ],
      },
    });
    const doc = parseFigma(json);
    expect(doc.root.children[0]?.tag).toBe("input");
    expect(doc.root.children[0]?.attributes).toMatchObject({
      type: "checkbox",
      checked: true,
    });
  });

  it("infers checkbox from suffixed instance component properties", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Consent Control Instance",
            type: "INSTANCE",
            componentProperties: {
              "Checked#0:1": { type: "BOOLEAN", value: true },
            },
          },
        ],
      },
    });
    const doc = parseFigma(json);
    expect(doc.root.children[0]?.tag).toBe("input");
    expect(doc.root.children[0]?.attributes).toMatchObject({
      type: "checkbox",
      checked: true,
    });
  });

  it("does not treat string true as a checked boolean property", () => {
    const json = JSON.stringify({
      document: {
        id: "0:0",
        name: "Root",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Checkbox/Marketing",
            type: "COMPONENT",
            componentProperties: {
              "Checked#0:1": { type: "BOOLEAN", value: "true" },
            },
          },
        ],
      },
    });
    const doc = parseFigma(json);
    expect(doc.root.children[0]?.tag).toBe("input");
    expect(doc.root.children[0]?.attributes.type).toBe("checkbox");
    expect(doc.root.children[0]?.attributes.checked).toBeUndefined();
  });

  it("enforces UTF-8 byte limit rather than UTF-16 code units", () => {
    const hugeJapanese = "あ".repeat(Math.floor(MAX_INPUT_BYTES / 3) + 1);
    const json = JSON.stringify({
      document: { id: "0:0", name: hugeJapanese, type: "CANVAS" },
    });
    expect(json.length).toBeLessThanOrEqual(MAX_INPUT_BYTES);
    expect(() => parseFigma(json)).toThrow(InputTooLargeError);
    try {
      parseFigma(json);
    } catch (error) {
      expect(error).toBeInstanceOf(InputTooLargeError);
      expect((error as InputTooLargeError).kind).toBe("bytes");
      expect((error as InputTooLargeError).actual).toBe(utf8ByteLength(json));
    }
  });

  it("reports node limit as limit plus one and does not leak counters across parses", () => {
    const children = Array.from({ length: MAX_NODE_COUNT }, (_, i) => ({
      id: `1:${i}`,
      name: `Node ${i}`,
      type: "FRAME",
    }));
    const tooMany = JSON.stringify({
      document: { id: "0:0", name: "Root", type: "CANVAS", children },
    });
    expect(() => parseFigma(tooMany)).toThrow(InputTooLargeError);
    try {
      parseFigma(tooMany);
    } catch (error) {
      expect((error as InputTooLargeError).kind).toBe("nodes");
      expect((error as InputTooLargeError).actual).toBe(MAX_NODE_COUNT + 1);
    }

    expect(parseFigma(REALISTIC_FIGMA).root.children.length).toBe(4);
  });
});
