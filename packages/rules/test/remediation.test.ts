import type { UiDocument, UiNode } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { removeCheckedAttributeRemediation } from "../src/remediation.js";

/**
 * The four things that must all be true before a `safe` edit is proposed, each refused on its own.
 *
 * Driven directly rather than through a scan, because three of them cannot be produced by any
 * adapter this repository ships — which is the point. A guard whose failure mode no test can reach
 * is a guard nobody can tell is working, and the CLI tests beside this one only exercise the paths
 * a real document takes.
 */

/**
 * Any lowercase hex SHA-256 will do: this module checks the *shape* and copies it forward, and
 * whether it matches the file is the applier's job. `@fairux/rules` is browser-safe and has no
 * hashing of its own, which is the reason the checksum arrives on the document at all.
 */
const CHECKSUM = "a".repeat(64);

/** A node as the static HTML adapter builds it, with the range for `checked`. */
function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    id: "0.1",
    tag: "input",
    attributes: { type: "checkbox", checked: true },
    directText: "",
    subtreeText: "",
    normalizedText: "",
    children: [],
    locator: { type: "css", value: "input" },
    attributeRanges: {
      checked: {
        startLine: 1,
        startColumn: 30,
        endLine: 1,
        endColumn: 38,
        text: " checked",
      },
    },
    ...overrides,
  } as UiNode;
}

/** A document as the CLI builds it: source ranges claimed, file named, bytes hashed. */
function doc(overrides: {
  capabilities?: readonly string[] | undefined;
  file?: string | undefined;
  sourceChecksum?: string | undefined;
}): UiDocument {
  return {
    runtime: "html",
    capabilities: "capabilities" in overrides ? overrides.capabilities : ["source-range"],
    metadata: {
      file: "file" in overrides ? overrides.file : "page.html",
      sourceChecksum: "sourceChecksum" in overrides ? overrides.sourceChecksum : CHECKSUM,
    },
  } as unknown as UiDocument;
}

const options = { ruleId: "consent/checked-checkbox", label: "Email me offers" };
const propose = (document: UiDocument, target: UiNode = node()) =>
  removeCheckedAttributeRemediation(document, target, options);

describe("a complete proof", () => {
  it("proposes one safe edit that deletes the attribute and its leading whitespace", () => {
    const remediation = propose(doc({}));
    expect(remediation?.safety).toBe("safe");
    expect(remediation?.origin).toBe("rule");
    expect(remediation?.file).toBe("page.html");
    expect(remediation?.fileChecksum).toBe(CHECKSUM);
    expect(remediation?.edits).toHaveLength(1);
    expect(remediation?.edits[0]?.expected).toBe(" checked");
    expect(remediation?.edits[0]?.replacement).toBe("");
    // The label is quoted back so a reviewer reading the plan knows which box moved.
    expect(remediation?.description).toContain("Email me offers");
  });

  it("names the node, so two boxes in one file do not share a remediation id", () => {
    const first = propose(doc({}), node({ id: "0.1" }));
    const second = propose(doc({}), node({ id: "0.2" }));
    expect(first?.id).not.toBe(second?.id);
  });
});

describe("an incomplete proof produces nothing at all", () => {
  /**
   * Not `review-required`. That would claim a fix exists and put the work of refusing it on a
   * reader; the honest answer to "I do not know exactly what to change" is silence.
   */
  it("refuses a document that does not claim source-range, even when a range is present", () => {
    // No adapter here produces this, and that is why it is checked here: capabilities are what a
    // document says it can answer for, and reading a value it never promised is what the
    // capability system exists to stop — whether or not the value happens to be sitting there.
    expect(propose(doc({ capabilities: undefined }))).toBeUndefined();
    expect(propose(doc({ capabilities: ["structure", "attributes"] }))).toBeUndefined();
  });

  it("refuses a document that does not name its file", () => {
    expect(propose(doc({ file: undefined }))).toBeUndefined();
    expect(propose(doc({ file: "" }))).toBeUndefined();
  });

  it("refuses a checksum that is missing or not lowercase hex SHA-256", () => {
    expect(propose(doc({ sourceChecksum: undefined }))).toBeUndefined();
    expect(propose(doc({ sourceChecksum: CHECKSUM.toUpperCase() }))).toBeUndefined();
    expect(propose(doc({ sourceChecksum: "not-a-checksum" }))).toBeUndefined();
    expect(propose(doc({ sourceChecksum: CHECKSUM.slice(0, 63) }))).toBeUndefined();
  });

  it("refuses a node with no recorded range for checked", () => {
    expect(propose(doc({}), node({ attributeRanges: undefined }))).toBeUndefined();
    expect(propose(doc({}), node({ attributeRanges: {} }))).toBeUndefined();
  });

  it("refuses a range holding anything but a plain boolean checked", () => {
    const spelling = (text: string) =>
      node({
        attributeRanges: {
          checked: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 + text.length, text },
        },
      });
    for (const text of [
      ' checked="yes"',
      " checked=true",
      "checked", // no leading whitespace: removing it would join two attributes
      ' data-checked="checked"',
      " checked class=x",
    ]) {
      expect(propose(doc({}), spelling(text)), text).toBeUndefined();
    }
  });

  it("accepts every spelling whose meaning is beyond argument", () => {
    const spelling = (text: string) =>
      node({
        attributeRanges: {
          checked: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 + text.length, text },
        },
      });
    for (const text of [
      " checked",
      ' checked=""',
      " checked=''",
      ' checked="checked"',
      " checked='checked'",
      " checked=checked",
      " CHECKED",
      "\n           checked",
      "\r\n  checked",
    ]) {
      expect(propose(doc({}), spelling(text)), JSON.stringify(text)).toBeDefined();
    }
  });
});
