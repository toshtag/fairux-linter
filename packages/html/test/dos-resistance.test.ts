import { InputTooLargeError, MAX_NODE_COUNT, MAX_TREE_DEPTH } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/parse.js";

describe("parseHtml DoS resistance (P10-T9)", () => {
  it("throws InputTooLargeError on deeply nested input", () => {
    const depth = MAX_TREE_DEPTH + 10;
    let html = "<html><body>";
    for (let i = 0; i < depth; i++) html += "<div>";
    html += "x";
    for (let i = 0; i < depth; i++) html += "</div>";
    html += "</body></html>";

    expect(() => parseHtml(html)).toThrow(InputTooLargeError);
    expect(() => parseHtml(html)).toThrow(/depth/i);
    try {
      parseHtml(html);
    } catch (error) {
      expect(error).toBeInstanceOf(InputTooLargeError);
      expect((error as InputTooLargeError).kind).toBe("depth");
      expect((error as InputTooLargeError).actual).toBe(MAX_TREE_DEPTH + 1);
    }
  });

  it("throws InputTooLargeError on too many nodes", () => {
    let html = "<html><body>";
    for (let i = 0; i < 60_000; i++) html += "<span>x</span>";
    html += "</body></html>";

    expect(() => parseHtml(html)).toThrow(InputTooLargeError);
    expect(() => parseHtml(html)).toThrow(/nodes/i);
    try {
      parseHtml(html);
    } catch (error) {
      expect(error).toBeInstanceOf(InputTooLargeError);
      expect((error as InputTooLargeError).kind).toBe("nodes");
      expect((error as InputTooLargeError).actual).toBe(MAX_NODE_COUNT + 1);
    }
  });

  it("parses normal input without error", () => {
    const html = "<html><body><div><p>Hello</p></div></body></html>";
    const doc = parseHtml(html);
    expect(doc.all().length).toBeGreaterThan(0);
  });
});
