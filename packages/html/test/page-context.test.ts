import { describe, expect, it } from "vitest";
import { detectPageContexts } from "../src/index.js";

describe("detectPageContexts", () => {
  it("flags checkout from the title with high confidence", () => {
    expect(detectPageContexts("", "secure checkout")).toContainEqual({
      context: "checkout",
      confidence: "high",
    });
  });

  it("flags consent from body text with medium confidence", () => {
    expect(detectPageContexts("we use cookies to improve", undefined)).toContainEqual({
      context: "consent",
      confidence: "medium",
    });
  });

  it("detects Japanese subscription keywords", () => {
    const contexts = detectPageContexts("無料体験を始める", undefined).map((s) => s.context);
    expect(contexts).toContain("subscription");
  });

  it("returns unknown when nothing matches", () => {
    expect(detectPageContexts("hello world", undefined)).toEqual([
      { context: "unknown", confidence: "low" },
    ]);
  });
});
