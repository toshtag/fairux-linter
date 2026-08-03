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

    // Parsed once, then asked four questions. `error` stays `undefined` when nothing throws, and
    // `toBeInstanceOf` fails on that — so the guard `expect(...).toThrow()` gave is still here.
    let error: unknown;
    try {
      parseHtml(html);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect((error as Error).message).toMatch(/depth/i);
    expect((error as InputTooLargeError).kind).toBe("depth");
    expect((error as InputTooLargeError).actual).toBe(MAX_TREE_DEPTH + 1);
  });

  it("throws InputTooLargeError on too many nodes", () => {
    let html = "<html><body>";
    for (let i = 0; i < 60_000; i++) html += "<span>x</span>";
    html += "</body></html>";

    let error: unknown;
    try {
      parseHtml(html);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect((error as Error).message).toMatch(/nodes/i);
    expect((error as InputTooLargeError).kind).toBe("nodes");
    expect((error as InputTooLargeError).actual).toBe(MAX_NODE_COUNT + 1);
  });

  it("parses normal input without error", () => {
    const html = "<html><body><div><p>Hello</p></div></body></html>";
    const doc = parseHtml(html);
    expect(doc.all().length).toBeGreaterThan(0);
  });
});
