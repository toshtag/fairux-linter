import type { UiNode } from "@fairux/core";
import { RUNTIME_CAPABILITIES, resolveDocumentCapabilities } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/index.js";

const page = `<!doctype html>
<html lang="en">
<head><title>Checkout</title></head>
<body>
  <div class="banner" style="opacity:0.6">
    <button class="btn-primary" data-action="accept">Accept all</button>
    <input type="checkbox" id="marketing" checked>
  </div>
</body>
</html>`;

const doc = parseHtml(page, { file: "checkout.html" });
const nodes: readonly UiNode[] = doc.all();

/**
 * The static-HTML row of `RUNTIME_CAPABILITIES`, checked against a document this adapter produced.
 *
 * The table is a claim in `@fairux/core` about a package that does not import it. Left unchecked it
 * would be a second, drifting description of this adapter — which is exactly the failure the table
 * exists to prevent elsewhere.
 */
describe("what the HTML adapter supplies", () => {
  it("resolves to the static-HTML baseline", () => {
    expect(doc.capabilities).toBeUndefined();
    expect(resolveDocumentCapabilities(doc)).toEqual(RUNTIME_CAPABILITIES.html);
  });

  it("backs `structure`: a tree with containment, not a flat list", () => {
    expect(RUNTIME_CAPABILITIES.html).toContain("structure");
    const banner = nodes.find((node) => node.attributes.class === "banner");
    expect(banner?.children.map((child) => child.tag)).toEqual(["button", "input"]);
  });

  it("backs `text`: own text and subtree text, normalized", () => {
    expect(RUNTIME_CAPABILITIES.html).toContain("text");
    const button = nodes.find((node) => node.tag === "button");
    expect(button?.directText).toBe("Accept all");
    expect(button?.normalizedText).toBe("accept all");
  });

  it("backs `attributes`: values as written, and boolean presence as `true`", () => {
    expect(RUNTIME_CAPABILITIES.html).toContain("attributes");
    const checkbox = nodes.find((node) => node.tag === "input");
    expect(checkbox?.attributes["data-action"]).toBeUndefined();
    expect(checkbox?.attributes.checked).toBe(true);
    expect(nodes.find((node) => node.tag === "button")?.attributes["data-action"]).toBe("accept");
  });

  it("backs `source-location`: a file, a line, and a column", () => {
    expect(RUNTIME_CAPABILITIES.html).toContain("source-location");
    const button = nodes.find((node) => node.tag === "button");
    expect(button?.source?.file).toBe("checkout.html");
    expect(typeof button?.source?.startLine).toBe("number");
    expect(typeof button?.source?.startColumn).toBe("number");
  });

  it("backs `style-hints`: class names and inline style declarations survive", () => {
    expect(RUNTIME_CAPABILITIES.html).toContain("style-hints");
    expect(nodes.find((node) => node.tag === "button")?.attributes.class).toBe("btn-primary");
    expect(nodes.find((node) => node.attributes.class === "banner")?.attributes.style).toBe(
      "opacity:0.6",
    );
  });

  it("claims no `dom-state`: the attribute is what was authored, not what a user left", () => {
    // The checkbox above reads `checked` because the markup says so. Nothing here ran script, and
    // nothing would show a box the user had since unticked.
    expect(RUNTIME_CAPABILITIES.html).not.toContain("dom-state");
  });
});
