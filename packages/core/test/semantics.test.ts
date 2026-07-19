import { describe, expect, it } from "vitest";
import { createUiSemantics } from "../src/index.js";
import { get, makeDoc } from "./_helpers.js";

describe("UiSemantics", () => {
  it("recognizes button-like nodes", () => {
    const doc = makeDoc({
      tag: "div",
      children: [
        { tag: "button", text: "Buy" },
        { tag: "input", attributes: { type: "submit" } },
        { tag: "span", role: "button", text: "Go" },
        { tag: "p", text: "no" },
      ],
    });
    const s = createUiSemantics(doc);
    expect(s.isButtonLike(get(doc, "0.0"))).toBe(true);
    expect(s.isButtonLike(get(doc, "0.1"))).toBe(true);
    expect(s.isButtonLike(get(doc, "0.2"))).toBe(true);
    expect(s.isButtonLike(get(doc, "0.3"))).toBe(false);
  });

  it("recognizes links and inputs", () => {
    const doc = makeDoc({
      tag: "div",
      children: [
        { tag: "a", attributes: { href: "/x" }, text: "link" },
        { tag: "a", text: "no href" },
        { tag: "select" },
      ],
    });
    const s = createUiSemantics(doc);
    expect(s.isLinkLike(get(doc, "0.0"))).toBe(true);
    expect(s.isLinkLike(get(doc, "0.1"))).toBe(false);
    expect(s.isInput(get(doc, "0.2"))).toBe(true);
  });

  it("derives a control label from an associated <label for>", () => {
    const doc = makeDoc({
      tag: "form",
      children: [
        { tag: "label", attributes: { for: "agree" }, text: "I agree to marketing emails" },
        { tag: "input", attributes: { type: "checkbox", id: "agree", checked: true } },
      ],
    });
    const s = createUiSemantics(doc);
    expect(s.getControlLabel(get(doc, "0.1"))).toBe("I agree to marketing emails");
  });

  it("uses its own text as a button label", () => {
    const doc = makeDoc({ tag: "div", children: [{ tag: "button", text: "Start free trial" }] });
    const s = createUiSemantics(doc);
    expect(s.getControlLabel(get(doc, "0.0"))).toBe("Start free trial");
  });
});
