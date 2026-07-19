import { describe, expect, it } from "vitest";
import { buildSelector } from "../src/index.js";

describe("buildSelector", () => {
  it("prefers a safe #id", () => {
    expect(buildSelector("html > body", "div", 2, "main")).toBe("#main");
  });

  it("ignores an unsafe id and falls back to an nth-child path", () => {
    expect(buildSelector("html > body", "div", 2, "1bad id")).toBe(
      "html > body > div:nth-child(2)",
    );
  });

  it("returns the bare tag for the root (no parent selector)", () => {
    expect(buildSelector(undefined, "html", 1, undefined)).toBe("html");
  });

  it("builds an nth-child path when there is no id", () => {
    expect(buildSelector("#form", "input", 3, undefined)).toBe("#form > input:nth-child(3)");
  });
});
