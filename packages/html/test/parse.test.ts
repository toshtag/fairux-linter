import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/index.js";

const html = `<!doctype html>
<html lang="ja">
<head><title>Checkout</title></head>
<body>
  <form id="pay">
    <label for="agree">利用規約に同意する</label>
    <input type="checkbox" id="agree" checked>
    <button type="submit">無料体験を始める</button>
    <img src="x.png" alt="ロゴ">
  </form>
</body>
</html>`;

const doc = parseHtml(html, { file: "page.html" });
const first = (tag: string) => doc.findAll((n) => n.tag === tag)[0];

describe("parseHtml", () => {
  it("sets runtime and metadata", () => {
    expect(doc.runtime).toBe("html");
    expect(doc.metadata?.file).toBe("page.html");
    expect(doc.metadata?.title).toBe("Checkout");
    expect(doc.metadata?.locale).toBe("ja");
  });

  it("represents boolean attributes as true", () => {
    const checkbox = first("input");
    expect(checkbox?.attributes.checked).toBe(true);
    expect(checkbox?.attributes.type).toBe("checkbox");
  });

  it("computes directText / subtreeText / normalizedText", () => {
    const button = first("button");
    expect(button?.directText).toBe("無料体験を始める");
    expect(button?.normalizedText).toBe("無料体験を始める");
    const form = first("form");
    expect(form?.subtreeText).toContain("無料体験を始める");
    expect(form?.subtreeText).toContain("利用規約に同意する");
  });

  it("extracts a best-effort accessible name from alt", () => {
    expect(first("img")?.accessibility).toEqual({ name: "ロゴ", nameSource: "alt" });
  });

  it("records source location and a css locator", () => {
    const button = first("button");
    expect(button?.source?.file).toBe("page.html");
    expect(typeof button?.source?.startLine).toBe("number");
    expect(button?.locator.type).toBe("css");
  });

  it("links parent/child via parentId + getNode", () => {
    const button = first("button");
    expect(button).toBeDefined();
    const parent = button?.parentId ? doc.getNode(button.parentId) : undefined;
    expect(parent?.tag).toBe("form");
  });

  it("detects page contexts from content", () => {
    const contexts = doc.pageContexts.map((s) => s.context);
    expect(contexts).toContain("subscription"); // 無料体験
    expect(contexts).toContain("consent"); // 同意
  });
});
