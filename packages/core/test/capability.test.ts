import { describe, expect, it } from "vitest";
import type { CapabilityId, Runtime } from "../src/index.js";
import {
  BUILTIN_CAPABILITIES,
  BUILTIN_CAPABILITY_IDS,
  isBuiltinCapabilityId,
  RUNTIME_CAPABILITIES,
  resolveDocumentCapabilities,
  sortCapabilityIds,
} from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const RUNTIMES: readonly Runtime[] = ["html", "dom", "ast", "figma"];

describe("the built-in capability vocabulary", () => {
  it("describes every id exactly once, in a fixed order", () => {
    expect(BUILTIN_CAPABILITY_IDS).toEqual([
      "structure",
      "text",
      "attributes",
      "source-location",
      "dom-state",
      "style-hints",
      "computed-style",
      "viewport",
      "interaction",
      "journey",
      "form",
      "network",
    ]);
    expect(new Set(BUILTIN_CAPABILITY_IDS).size).toBe(BUILTIN_CAPABILITY_IDS.length);
    expect(BUILTIN_CAPABILITIES.map((capability) => capability.id)).toEqual(BUILTIN_CAPABILITY_IDS);
  });

  it("gives every capability a title and a description of what an input must supply", () => {
    for (const capability of BUILTIN_CAPABILITIES) {
      expect(capability.title.trim()).not.toBe("");
      expect(capability.description.trim()).not.toBe("");
    }
  });

  it("is frozen, so a consumer cannot edit the vocabulary another consumer reads", () => {
    expect(Object.isFrozen(BUILTIN_CAPABILITIES)).toBe(true);
    for (const capability of BUILTIN_CAPABILITIES) expect(Object.isFrozen(capability)).toBe(true);
  });

  it("recognises built-in ids and nothing else", () => {
    expect(isBuiltinCapabilityId("dom-state")).toBe(true);
    expect(isBuiltinCapabilityId("acme/heatmap")).toBe(false);
    expect(isBuiltinCapabilityId("Structure")).toBe(false);
    expect(isBuiltinCapabilityId("")).toBe(false);
  });
});

describe("per-runtime capability baselines", () => {
  it("covers every runtime with built-in ids only", () => {
    for (const runtime of RUNTIMES) {
      const capabilities = RUNTIME_CAPABILITIES[runtime];
      expect(capabilities.length).toBeGreaterThan(0);
      for (const capability of capabilities) expect(isBuiltinCapabilityId(capability)).toBe(true);
    }
  });

  it("claims nothing today for the capabilities no adapter can supply", () => {
    for (const runtime of RUNTIMES) {
      expect(RUNTIME_CAPABILITIES[runtime]).not.toContain("computed-style");
      expect(RUNTIME_CAPABILITIES[runtime]).not.toContain("viewport");
      expect(RUNTIME_CAPABILITIES[runtime]).not.toContain("interaction");
      expect(RUNTIME_CAPABILITIES[runtime]).not.toContain("journey");
      expect(RUNTIME_CAPABILITIES[runtime]).not.toContain("form");
      expect(RUNTIME_CAPABILITIES[runtime]).not.toContain("network");
    }
  });

  it("separates the runtimes by what their input actually carries", () => {
    // A live DOM has no source lines; static HTML and JSX/TSX do.
    expect(RUNTIME_CAPABILITIES.html).toContain("source-location");
    expect(RUNTIME_CAPABILITIES.ast).toContain("source-location");
    expect(RUNTIME_CAPABILITIES.dom).not.toContain("source-location");
    expect(RUNTIME_CAPABILITIES.figma).not.toContain("source-location");

    // Only a live DOM reads state back after script has run.
    expect(RUNTIME_CAPABILITIES.dom).toContain("dom-state");
    expect(RUNTIME_CAPABILITIES.html).not.toContain("dom-state");

    // A Figma document has no class names and no inline style declarations.
    expect(RUNTIME_CAPABILITIES.figma).not.toContain("style-hints");
  });
});

describe("resolveDocumentCapabilities", () => {
  it("falls back to the runtime baseline when a document declares nothing", () => {
    const doc = makeDoc({ tag: "div" }, { runtime: "figma" });
    expect(doc.capabilities).toBeUndefined();
    expect(resolveDocumentCapabilities(doc)).toEqual(RUNTIME_CAPABILITIES.figma);
  });

  it("takes a document's own declaration over the baseline", () => {
    const doc = makeDoc(
      { tag: "div" },
      { runtime: "dom", capabilities: ["structure", "text", "computed-style"] },
    );
    expect(resolveDocumentCapabilities(doc)).toEqual(["structure", "text", "computed-style"]);
  });

  it("treats an empty declaration as an answer, not as a missing one", () => {
    const doc = makeDoc({ tag: "div" }, { runtime: "html", capabilities: [] });
    expect(resolveDocumentCapabilities(doc)).toEqual([]);
  });

  it("returns capabilities in vocabulary order regardless of how they were declared", () => {
    const doc = makeDoc(
      { tag: "div" },
      { runtime: "html", capabilities: ["style-hints", "structure", "text"] },
    );
    expect(resolveDocumentCapabilities(doc)).toEqual(["structure", "text", "style-hints"]);
  });
});

describe("sortCapabilityIds", () => {
  it("orders built-ins by the vocabulary and namespaced ids after them, lexicographically", () => {
    const input: CapabilityId[] = [
      "acme/heatmap",
      "network",
      "structure",
      "zeta/telemetry",
      "text",
    ];
    expect(sortCapabilityIds(input)).toEqual([
      "structure",
      "text",
      "network",
      "acme/heatmap",
      "zeta/telemetry",
    ]);
  });

  it("deduplicates, so a set assembled from several rules needs no second pass", () => {
    expect(sortCapabilityIds(["text", "structure", "text"])).toEqual(["structure", "text"]);
  });
});
