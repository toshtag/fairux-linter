import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "../src/index.js";

describe("utf8ByteLength", () => {
  it("counts ASCII bytes", () => {
    expect(utf8ByteLength("abc")).toBe(3);
  });

  it("counts Japanese bytes", () => {
    expect(utf8ByteLength("あいう")).toBe(9);
  });

  it("counts emoji surrogate pairs as four bytes", () => {
    expect(utf8ByteLength("🙂")).toBe(4);
  });

  it("counts lone surrogates as replacement-sized UTF-8", () => {
    expect(utf8ByteLength("\uD83D")).toBe(3);
    expect(utf8ByteLength("\uDE42")).toBe(3);
  });
});
