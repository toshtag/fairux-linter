import { describe, expect, it } from "vitest";
import { normalizeText } from "../src/index.js";

describe("normalizeText", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeText("  Free   Trial ")).toBe("free trial");
  });

  it("applies NFKC to full-width digits", () => {
    expect(normalizeText("０円")).toBe("0円");
  });

  it("normalizes the full-width yen sign", () => {
    expect(normalizeText("￥1,000")).toBe("¥1,000");
  });

  it("treats the ideographic space as whitespace", () => {
    expect(normalizeText("税　込")).toBe("税 込");
  });

  it("folds half-width katakana to full-width", () => {
    expect(normalizeText("ｶﾅ")).toBe("カナ");
  });
});
