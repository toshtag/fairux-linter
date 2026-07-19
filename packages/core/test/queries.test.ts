import { describe, expect, it } from "vitest";
import { createNodeQueries } from "../src/index.js";
import { get, makeDoc } from "./_helpers.js";

const doc = makeDoc({
  tag: "div",
  children: [
    { tag: "section", text: "Header", children: [{ tag: "button", text: "Start" }] },
    { tag: "p", text: "Footer" },
  ],
});
const queries = createNodeQueries(doc);
const root = get(doc, "0");
const section = get(doc, "0.0");
const button = get(doc, "0.0.0");

describe("NodeQueries", () => {
  it("walks ancestors via parentId", () => {
    expect(queries.ancestors(button).map((n) => n.id)).toEqual(["0.0", "0"]);
  });

  it("collects the whole subtree as descendants", () => {
    expect(
      queries
        .descendants(root)
        .map((n) => n.tag)
        .sort(),
    ).toEqual(["button", "p", "section"]);
  });

  it("finds the nearest matching ancestor (or self) with closest", () => {
    expect(queries.closest(button, (n) => n.tag === "section")?.id).toBe("0.0");
    expect(queries.closest(button, (n) => n.tag === "button")?.id).toBe("0.0.0");
  });

  it("returns the parent's normalized text from nearbyText", () => {
    expect(queries.nearbyText(button, 1)).toBe(section.normalizedText);
    expect(section.normalizedText).toContain("start");
  });
});
