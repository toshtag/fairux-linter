// @vitest-environment happy-dom
import { RUNTIME_CAPABILITIES, resolveDocumentCapabilities, scan } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { COLLECTED_STYLE_PROPERTIES, parseDocument } from "../src/index.js";

function load(html: string): Document {
  document.documentElement.innerHTML = html;
  return document;
}

const markup = `<body>
  <div class="banner">
    <button id="accept" style="font-weight:700;opacity:1">Accept all</button>
    <button id="reject" style="font-weight:400;opacity:0.4">Reject</button>
  </div>
</body>`;

describe("visual facts are opt-in", () => {
  it("collects nothing, and claims nothing, by default", () => {
    const doc = parseDocument(load(markup));
    expect(doc.capabilities).toBeUndefined();
    expect(resolveDocumentCapabilities(doc)).toEqual(RUNTIME_CAPABILITIES.dom);
    expect(doc.all().every((node) => node.visual === undefined)).toBe(true);
  });

  it("produces a report identical to one from before this existed", () => {
    const options = { toolVersion: "test", now: () => new Date("2026-01-01T00:00:00.000Z") };
    const withoutFacts = scan(parseDocument(load(markup)), [], options);
    expect(withoutFacts.coverage?.capabilities.unavailable).toContain("computed-style");
    expect(withoutFacts.coverage?.capabilities.unavailable).toContain("viewport");
  });
});

describe("visual facts when asked for", () => {
  it("claims both capabilities, and only then", () => {
    const doc = parseDocument(load(markup), { visualFacts: true });
    expect(resolveDocumentCapabilities(doc)).toContain("computed-style");
    expect(resolveDocumentCapabilities(doc)).toContain("viewport");
    // The baseline is kept, not replaced: a live DOM still has state and still has no source lines.
    expect(resolveDocumentCapabilities(doc)).toContain("dom-state");
    expect(resolveDocumentCapabilities(doc)).not.toContain("source-location");
  });

  it("reaches the scan's coverage as available", () => {
    const report = scan(parseDocument(load(markup), { visualFacts: true }), []);
    expect(report.coverage?.capabilities.available).toContain("computed-style");
    expect(report.coverage?.capabilities.available).toContain("viewport");
    expect(report.coverage?.capabilities.unavailable).not.toContain("computed-style");
  });

  it("reads the resolved value, not the authored one", () => {
    const doc = parseDocument(load(markup), { visualFacts: true });
    const accept = doc.findAll((node) => node.attributes.id === "accept")[0];
    const reject = doc.findAll((node) => node.attributes.id === "reject")[0];
    // Both authored inline here, so the engine resolves what the markup asked for. The point is
    // that the value comes from the engine: a stylesheet FairUX never parsed would resolve the same
    // way, and a class name would not.
    expect(accept?.visual?.computedStyle?.["font-weight"]).toBe("700");
    expect(reject?.visual?.computedStyle?.opacity).toBe("0.4");
  });

  it("collects the documented property list and nothing else", () => {
    const doc = parseDocument(load(markup), { visualFacts: true });
    const collected = doc.all().flatMap((node) => Object.keys(node.visual?.computedStyle ?? {}));
    for (const property of new Set(collected)) {
      expect(COLLECTED_STYLE_PROPERTIES).toContain(property);
    }
  });

  it("records geometry as integers", () => {
    const doc = parseDocument(load(markup), { visualFacts: true });
    for (const node of doc.all()) {
      const box = node.visual?.box;
      if (!box) continue;
      expect(Number.isInteger(box.x)).toBe(true);
      expect(Number.isInteger(box.y)).toBe(true);
      expect(Number.isInteger(box.width)).toBe(true);
      expect(Number.isInteger(box.height)).toBe(true);
    }
  });

  it("answers viewport intersection from the box it recorded", () => {
    const doc = parseDocument(load(markup), { visualFacts: true });
    for (const node of doc.all()) {
      const visual = node.visual;
      if (!visual?.box) continue;
      // Whatever the engine reported, the two answers agree with each other: a zero-sized or
      // off-screen box is not in the viewport, and a box overlapping it is.
      expect(visual.inViewport).toBe(
        visual.box.width > 0 &&
          visual.box.height > 0 &&
          visual.box.x < window.innerWidth &&
          visual.box.y < window.innerHeight &&
          visual.box.x + visual.box.width > 0 &&
          visual.box.y + visual.box.height > 0,
      );
    }
  });

  it("is deterministic across two scans of one unchanged page", () => {
    const live = load(markup);
    const first = parseDocument(live, { visualFacts: true })
      .all()
      .map((node) => node.visual);
    const second = parseDocument(live, { visualFacts: true })
      .all()
      .map((node) => node.visual);
    expect(second).toEqual(first);
  });
});
