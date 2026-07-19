import { describe, expect, it } from "vitest";
import {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
} from "../src/limits.js";

describe("DoS resistance limits", () => {
  it("MAX_INPUT_BYTES is 10 MB", () => {
    expect(MAX_INPUT_BYTES).toBe(10 * 1024 * 1024);
  });

  it("MAX_NODE_COUNT is 50000", () => {
    expect(MAX_NODE_COUNT).toBe(50_000);
  });

  it("MAX_TREE_DEPTH is 500", () => {
    expect(MAX_TREE_DEPTH).toBe(500);
  });

  it("InputTooLargeError carries limit, actual, and kind", () => {
    const err = new InputTooLargeError(100, 200, "bytes");
    expect(err.limit).toBe(100);
    expect(err.actual).toBe(200);
    expect(err.kind).toBe("bytes");
    expect(err.message).toContain("100");
    expect(err.message).toContain("200");
    expect(err.message).toContain("bytes");
    expect(err.name).toBe("InputTooLargeError");
  });

  it("InputTooLargeError works for nodes kind", () => {
    const err = new InputTooLargeError(MAX_NODE_COUNT, 99999, "nodes");
    expect(err.kind).toBe("nodes");
    expect(err.message).toContain("nodes");
  });

  it("InputTooLargeError works for depth kind", () => {
    const err = new InputTooLargeError(MAX_TREE_DEPTH, 600, "depth");
    expect(err.kind).toBe("depth");
    expect(err.message).toContain("depth");
  });
});
