import { describe, expect, it } from "vitest";
import { parseSource } from "../src/index.js";

const first = (doc: ReturnType<typeof parseSource>, tag: string) =>
  doc.findAll((n) => n.tag === tag)[0];

describe("parseSource", () => {
  it("sets runtime ast and ast-kind locator + source with line/column", () => {
    const doc = parseSource(`const a = <button>Buy</button>;`, { file: "a.tsx" });
    expect(doc.runtime).toBe("ast");
    const button = first(doc, "button");
    expect(button?.locator.type).toBe("ast");
    expect(button?.source?.file).toBe("a.tsx");
    expect(typeof button?.source?.startLine).toBe("number");
  });

  it("reads static string and boolean-shorthand attributes", () => {
    const doc = parseSource(`const a = <input type="checkbox" checked className="primary" />;`);
    const input = first(doc, "input");
    expect(input?.attributes.type).toBe("checkbox");
    expect(input?.attributes.checked).toBe(true);
    expect(input?.attributes.class).toBe("primary"); // className → class
  });

  it("treats an expression attribute as UNKNOWN (never asserts the value)", () => {
    const doc = parseSource(`const a = <input type="checkbox" checked={isOn} />;`);
    const input = first(doc, "input");
    // checked is dynamic → must NOT be recorded as true
    expect(input?.attributes.checked).toBeUndefined();
    expect(input?.attributes["data-fairux-dynamic"]).toContain("checked");
  });

  it("keeps a string-literal expression attribute as static", () => {
    const doc = parseSource(`const a = <button aria-label={"Close"}>×</button>;`);
    const button = first(doc, "button");
    expect(button?.accessibility).toEqual({ name: "Close", nameSource: "aria-label" });
  });

  it("collects static text but ignores dynamic expression children", () => {
    const doc = parseSource(`const a = <p>Only {count} left in stock</p>;`);
    const p = first(doc, "p");
    expect(p?.directText).toBe("Only left in stock"); // {count} contributes nothing
  });

  it("marks component elements and lowercases the tag", () => {
    const doc = parseSource(`const a = <PricingCard plan="pro" />;`);
    const card = doc.findAll((n) => n.attributes["data-fairux-component"] === "PricingCard")[0];
    expect(card).toBeDefined();
    expect(card?.tag).toBe("pricingcard");
  });

  it("flags a spread attribute as dynamic", () => {
    const doc = parseSource(`const a = <input {...props} />;`);
    const input = first(doc, "input");
    expect(input?.attributes["data-fairux-dynamic"]).toContain("...spread");
  });

  it("wraps multiple top-level JSX trees under a synthetic fragment", () => {
    const doc = parseSource(`const a = <div>one</div>; const b = <div>two</div>;`);
    expect(doc.root.tag).toBe("fragment");
    expect(doc.findAll((n) => n.tag === "div")).toHaveLength(2);
  });

  it("links parent/child via parentId + getNode", () => {
    const doc = parseSource(`const a = <form><button>Go</button></form>;`);
    const button = first(doc, "button");
    const parent = button?.parentId ? doc.getNode(button.parentId) : undefined;
    expect(parent?.tag).toBe("form");
  });
});
