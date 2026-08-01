// @vitest-environment happy-dom
import { RUNTIME_CAPABILITIES, resolveDocumentCapabilities } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/index.js";

function load(html: string): Document {
  document.documentElement.innerHTML = html;
  return document;
}

const markup = `<body>
  <div class="banner" style="opacity:0.6">
    <button class="btn-primary" data-action="accept">Accept all</button>
    <input type="checkbox" id="marketing">
  </div>
</body>`;

/**
 * The live-DOM row of `RUNTIME_CAPABILITIES`, checked against a document this adapter produced.
 *
 * Two entries carry the whole difference from static HTML: a live DOM has state and no source lines.
 * Both are checked here rather than asserted in a table nobody re-reads.
 */
describe("what the DOM adapter supplies", () => {
  it("resolves to the live-DOM baseline", () => {
    const doc = parseDocument(load(markup));
    expect(doc.capabilities).toBeUndefined();
    expect(resolveDocumentCapabilities(doc)).toEqual(RUNTIME_CAPABILITIES.dom);
  });

  it("backs `structure` and `text`", () => {
    const doc = parseDocument(load(markup));
    const banner = doc.findAll((node) => node.attributes.class === "banner")[0];
    expect(banner?.children.map((child) => child.tag)).toEqual(["button", "input"]);
    expect(doc.findAll((node) => node.tag === "button")[0]?.normalizedText).toBe("accept all");
  });

  it("backs `attributes` and `style-hints`", () => {
    const doc = parseDocument(load(markup));
    const button = doc.findAll((node) => node.tag === "button")[0];
    expect(button?.attributes["data-action"]).toBe("accept");
    expect(button?.attributes.class).toBe("btn-primary");
    expect(doc.findAll((node) => node.attributes.class === "banner")[0]?.attributes.style).toBe(
      "opacity:0.6",
    );
  });

  it("backs `dom-state`: the box as the user left it, not as it was authored", () => {
    expect(RUNTIME_CAPABILITIES.dom).toContain("dom-state");
    const live = load(markup);
    const checkbox = live.getElementById("marketing") as HTMLInputElement;
    // Authored unchecked; ticked after load, with no attribute written back.
    checkbox.checked = true;
    expect(checkbox.getAttribute("checked")).toBeNull();
    const input = parseDocument(live).findAll((node) => node.tag === "input")[0];
    expect(input?.attributes.checked).toBe(true);
  });

  it("claims no `source-location`, and supplies none", () => {
    expect(RUNTIME_CAPABILITIES.dom).not.toContain("source-location");
    const doc = parseDocument(load(markup));
    expect(doc.all().every((node) => node.source === undefined)).toBe(true);
  });
});
