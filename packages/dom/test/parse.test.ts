// @vitest-environment happy-dom
import { InputTooLargeError, MAX_NODE_COUNT, MAX_TREE_DEPTH } from "@fairux/core";
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

  it("throws InputTooLargeError on deeply nested DOM", () => {
    const root = document.createElement("main");
    let current = root;
    for (let i = 0; i < MAX_TREE_DEPTH; i++) {
      const child = document.createElement("div");
      current.appendChild(child);
      current = child;
    }
    document.body.replaceChildren(root);

    // Walked once, then asked three questions. `error` stays `undefined` when nothing throws, and
    // `toBeInstanceOf` fails on that — so the guard `expect(...).toThrow()` gave is still here.
    let error: unknown;
    try {
      parseDocument(document, { root });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect((error as InputTooLargeError).kind).toBe("depth");
    expect((error as InputTooLargeError).actual).toBe(MAX_TREE_DEPTH + 1);
  });

  /**
   * The node-count boundary, with a budget of its own.
   *
   * It builds `MAX_NODE_COUNT` elements and walks them, which is the only test in this file that
   * is CPU- and allocation-bound rather than about a handful of nodes. Measured on an idle machine
   * it is under a second — 327ms building the tree, 76ms attaching it, 270ms in `parseDocument` —
   * and under the whole suite it is 1.0 to 1.4s. Inside `pnpm verify:full` it reached the global
   * 10-second budget and failed twice in four runs, on a tree where nothing was wrong.
   *
   * Seven times the observed cost is not enough headroom for a test whose work scales with how
   * many other workers are competing for the same cores. The fix is not a cheaper fixture: the
   * `appendChild` loop is 327ms of the 873ms, so building the same 50,000 spans through `innerHTML`
   * — measured at 198ms — moves the total by about 15% and the margin not at all.
   *
   * So this one test gets a local budget, the way `packages/ast/test/dos-resistance.test.ts` gives
   * its `MAX_NODE_COUNT` sibling 30 seconds for the same reason. The global stays at 10 seconds and
   * every other test in this file stays on it: a boundary test that allocates 50,000 nodes is not
   * the budget an ordinary DOM test should be written against.
   */
  it("throws InputTooLargeError on too many DOM nodes", () => {
    const root = document.createElement("main");
    for (let i = 0; i < MAX_NODE_COUNT; i++) {
      root.appendChild(document.createElement("span"));
    }
    document.body.replaceChildren(root);

    let error: unknown;
    try {
      parseDocument(document, { root });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect((error as InputTooLargeError).kind).toBe("nodes");
    expect((error as InputTooLargeError).actual).toBe(MAX_NODE_COUNT + 1);
  }, 30_000);
});
