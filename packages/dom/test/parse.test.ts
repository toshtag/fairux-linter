// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/index.js";

/** Render an HTML string into the happy-dom `document` and return it. */
function load(html: string): Document {
  document.documentElement.innerHTML = html;
  return document;
}

describe("parseDocument", () => {
  it("sets runtime to dom and leaves source undefined (no source lines in a live DOM)", () => {
    const doc = parseDocument(load("<body><button>Buy</button></body>"));
    expect(doc.runtime).toBe("dom");
    const button = doc.findAll((n) => n.tag === "button")[0];
    expect(button?.source).toBeUndefined();
    expect(button?.locator.type).toBe("css");
  });

  it("computes directText / subtreeText / normalizedText (NFKC)", () => {
    const doc = parseDocument(load("<body><section>Header <b>０円</b></section></body>"));
    const section = doc.findAll((n) => n.tag === "section")[0];
    expect(section?.subtreeText).toContain("Header");
    expect(section?.normalizedText).toContain("0円"); // full-width → NFKC
  });

  it("reads boolean attributes from live properties (reflects user state)", () => {
    const doc = load("<body><input type='checkbox' id='c'></body>");
    const checkbox = doc.getElementById("c") as HTMLInputElement;
    checkbox.checked = true; // user toggled it; no `checked` attribute present
    const parsed = parseDocument(doc);
    const node = parsed.findAll((n) => n.tag === "input")[0];
    expect(node?.attributes.checked).toBe(true);
  });

  it("derives a best-effort accessible name from aria-label", () => {
    const doc = parseDocument(load("<body><button aria-label='Close'>×</button></body>"));
    const button = doc.findAll((n) => n.tag === "button")[0];
    expect(button?.accessibility).toEqual({ name: "Close", nameSource: "aria-label" });
  });

  it("resolves aria-labelledby across nodes", () => {
    const doc = parseDocument(
      load("<body><span id='lbl'>Accept all</span><button aria-labelledby='lbl'></button></body>"),
    );
    const button = doc.findAll((n) => n.tag === "button")[0];
    expect(button?.accessibility?.nameSource).toBe("aria-labelledby");
    expect(button?.accessibility?.name).toBe("Accept all");
  });

  it("links parent/child via parentId + getNode", () => {
    const doc = parseDocument(load("<body><form><button>Go</button></form></body>"));
    const button = doc.findAll((n) => n.tag === "button")[0];
    const parent = button?.parentId ? doc.getNode(button.parentId) : undefined;
    expect(parent?.tag).toBe("form");
  });

  it("inlines an open shadow root and flags containsShadow", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<button>In shadow</button>";
    const doc = parseDocument(document);
    expect(doc.metadata?.containsShadow).toBe(true);
    const inShadow = doc.findAll((n) => n.tag === "button" && n.subtreeText.includes("In shadow"));
    expect(inShadow).toHaveLength(1);
  });

  it("can scan a subtree via options.root", () => {
    load("<body><div id='outside'>x</div><div id='modal'><button>Sub</button></div></body>");
    const modal = document.getElementById("modal") as Element;
    const doc = parseDocument(document, { root: modal });
    expect(doc.findAll((n) => n.tag === "button")).toHaveLength(1);
    expect(doc.root.tag).toBe("div");
  });

  it("detects page contexts from content", () => {
    const doc = parseDocument(load("<body><h1>Checkout</h1><p>Place order</p></body>"));
    expect(doc.pageContexts.map((s) => s.context)).toContain("checkout");
  });
});
