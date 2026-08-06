// @vitest-environment happy-dom
import { SHADOW_LOCATOR_SEPARATOR, splitCssLocator } from "@fairux/core";
import { beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "../src/index.js";

/**
 * What a locator means once a shadow root is in the way.
 *
 * The adapter walks into open shadow roots, so it produces nodes for elements no selector resolved
 * against the document can reach. It wrote one anyway: a flat `:nth-child` path counted across the
 * shadow children *and* the light children of the same host, resolved against the light DOM, and
 * matched whatever element sat at those indexes. The Chrome extension then outlined that element as
 * if it were the finding — the failure mode where being wrong looks exactly like being right.
 *
 * A locator crossing a boundary is a sequence now: one selector per root, joined by a separator that
 * is not valid CSS. Everything here is about that sequence being correct, and about an ordinary
 * document producing exactly the flat selector it always did.
 */

const attach = (host: Element, html: string, mode: "open" | "closed" = "open") => {
  const root = host.attachShadow({ mode });
  root.innerHTML = html;
  return root;
};

beforeEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
});

/** Resolve a locator the way the Chrome content script does, so the test drives the real contract. */
function resolve(value: string): Element | null {
  const segments = splitCssLocator(value);
  let scope: Document | ShadowRoot = document;
  let found: Element | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    found = scope.querySelector(segments[index] as string);
    if (!found) return null;
    if (index === segments.length - 1) break;
    const shadow: ShadowRoot | null | undefined = (
      found as Element & { shadowRoot?: ShadowRoot | null }
    ).shadowRoot;
    if (!shadow) return null;
    scope = shadow;
  }
  return found;
}

/** The `css` value of the one node matching a tag and some of its text. */
function locatorOf(tag: string, text: string): string {
  const doc = parseDocument(document);
  const node = doc.findAll((n) => n.tag === tag && n.subtreeText.includes(text))[0];
  if (!node) throw new Error(`no <${tag}> containing ${JSON.stringify(text)}`);
  if (node.locator.type !== "css") throw new Error(`a DOM node's locator must be css`);
  return node.locator.value;
}

describe("a document with no shadow root", () => {
  it("produces one flat selector, unchanged", () => {
    document.body.innerHTML = "<div><p>a</p><button>Buy</button></div>";
    const locator = locatorOf("button", "Buy");
    expect(locator).not.toContain(SHADOW_LOCATOR_SEPARATOR);
    expect(splitCssLocator(locator)).toHaveLength(1);
    expect(document.querySelector(locator)?.textContent).toBe("Buy");
  });
});

describe("a locator that crosses an open shadow root", () => {
  it("resolves to the element in the shadow root, not to something in the light DOM", () => {
    const host = document.createElement("my-banner");
    document.body.append(host);
    attach(host, "<div><button>Accept</button></div>");

    const locator = locatorOf("button", "Accept");
    expect(locator).toContain(SHADOW_LOCATOR_SEPARATOR);
    expect(resolve(locator)?.textContent).toBe("Accept");
  });

  it("resolves through a nested open shadow root", () => {
    const outer = document.createElement("my-banner");
    document.body.append(outer);
    const outerRoot = attach(outer, "<my-actions></my-actions>");
    const inner = outerRoot.querySelector("my-actions") as Element;
    attach(inner, "<button>Reject all</button>");

    const locator = locatorOf("button", "Reject all");
    expect(splitCssLocator(locator)).toHaveLength(3);
    expect(resolve(locator)?.textContent).toBe("Reject all");
  });

  it("numbers light children from 1, not from after the shadow children", () => {
    // The defect, at its sharpest. The host has two shadow children and two light children; the
    // flat list numbered `<em>` as :nth-child(4), which in the light DOM is nothing — or worse,
    // something. Each root counts its own.
    const host = document.createElement("my-card");
    host.innerHTML = "<span>slotted</span><em>also slotted</em>";
    document.body.append(host);
    attach(host, "<h2>Title</h2><p>Body</p>");

    const em = locatorOf("em", "also slotted");
    expect(em).not.toContain(SHADOW_LOCATOR_SEPARATOR);
    expect(em).toContain(":nth-child(2)");
    expect(resolve(em)?.textContent).toBe("also slotted");

    const body = locatorOf("p", "Body");
    expect(body).toContain(":nth-child(2)");
    expect(resolve(body)?.textContent).toBe("Body");
  });

  it("keeps an id inside a shadow root scoped to that root", () => {
    // `#cta` is unique inside the root, and `document.querySelector('#cta')` finds the light one.
    // The segment before it is what makes the difference.
    document.body.innerHTML = '<button id="cta">Light</button>';
    const host = document.createElement("my-card");
    document.body.append(host);
    attach(host, '<button id="cta">Shadow</button>');

    expect(resolve(locatorOf("button", "Shadow"))?.textContent).toBe("Shadow");
  });
});

describe("a closed shadow root", () => {
  it("contributes no nodes, so nothing claims to point inside it", () => {
    const host = document.createElement("my-secret");
    document.body.append(host);
    attach(host, "<button>Hidden</button>", "closed");

    const doc = parseDocument(document);
    expect(doc.findAll((n) => n.subtreeText.includes("Hidden"))).toHaveLength(0);
  });

  it("does not resolve a stale locator to the host, or to anything else", () => {
    // A page whose root was open at scan time and is not now: the sequence must end unresolved
    // rather than settle on the host, which is not the finding.
    const stale = `my-secret${SHADOW_LOCATOR_SEPARATOR}button:nth-child(1)`;
    const host = document.createElement("my-secret");
    document.body.append(host);
    attach(host, "<button>Hidden</button>", "closed");

    expect(resolve(stale)).toBeNull();
  });
});

describe("aria-labelledby does not cross a shadow boundary", () => {
  it("does not name a shadow element after a light-DOM id", () => {
    // No browser associates these. A single flat id index across the whole tree did.
    document.body.innerHTML = '<span id="lbl">Accept all cookies</span>';
    const host = document.createElement("my-card");
    document.body.append(host);
    attach(host, '<button aria-labelledby="lbl"></button>');

    const doc = parseDocument(document);
    const button = doc.findAll((n) => n.tag === "button")[0];
    expect(button?.accessibility).toBeUndefined();
  });

  it("does not name a light-DOM element after an id inside a shadow root", () => {
    const host = document.createElement("my-card");
    document.body.append(host);
    attach(host, '<span id="inner">Inside</span>');
    document.body.insertAdjacentHTML("beforeend", '<button aria-labelledby="inner">×</button>');

    const doc = parseDocument(document);
    const button = doc.findAll((n) => n.tag === "button")[0];
    expect(button?.accessibility).toBeUndefined();
  });

  it("still resolves within one root", () => {
    // The two checks above must not be passing because the feature stopped working.
    const host = document.createElement("my-card");
    document.body.append(host);
    attach(host, '<span id="lbl">Accept all</span><button aria-labelledby="lbl"></button>');

    const doc = parseDocument(document);
    const button = doc.findAll((n) => n.tag === "button")[0];
    expect(button?.accessibility).toEqual({ name: "Accept all", nameSource: "aria-labelledby" });

    document.documentElement.innerHTML =
      "<body><span id='lbl'>Light label</span><button aria-labelledby='lbl'></button></body>";
    const light = parseDocument(document).findAll((n) => n.tag === "button")[0];
    expect(light?.accessibility?.name).toBe("Light label");
  });
});
