import { InputTooLargeError, MAX_NODE_COUNT, MAX_TREE_DEPTH } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { parseSource } from "../src/parse.js";

describe("parseSource DoS resistance (P10-T9)", () => {
  it("throws InputTooLargeError on deeply nested JSX", () => {
    const depth = MAX_TREE_DEPTH + 10;
    let code = "";
    for (let i = 0; i < depth; i++) code += "<div>";
    code += "x";
    for (let i = 0; i < depth; i++) code += "</div>";

    // Parsed once, then asked four questions. `error` stays `undefined` when nothing throws, and
    // `toBeInstanceOf` fails on that — so the guard `expect(...).toThrow()` gave is still here.
    let error: unknown;
    try {
      parseSource(code);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect((error as Error).message).toMatch(/depth/i);
    expect((error as InputTooLargeError).kind).toBe("depth");
    expect((error as InputTooLargeError).actual).toBe(MAX_TREE_DEPTH + 1);
  });

  it("throws InputTooLargeError on too many JSX nodes", () => {
    let code = "<>";
    for (let i = 0; i < 60_000; i++) code += "<span>x</span>";
    code += "</>";

    let error: unknown;
    try {
      parseSource(code);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect((error as Error).message).toMatch(/nodes/i);
    expect((error as InputTooLargeError).kind).toBe("nodes");
    expect((error as InputTooLargeError).actual).toBe(MAX_NODE_COUNT + 1);
  }, 30_000);

  it("parses normal JSX without error", () => {
    const code = "<div><p>Hello</p></div>";
    const doc = parseSource(code);
    expect(doc.all().length).toBeGreaterThan(0);
  });
});
