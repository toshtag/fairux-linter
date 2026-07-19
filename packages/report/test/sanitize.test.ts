import { describe, expect, it } from "vitest";
import {
  escapeBackticks,
  sanitizeInlineCode,
  sanitizeMarkdownText,
  sanitizePath,
  stripControlChars,
  stripNewlines,
} from "../src/sanitize.js";

describe("stripControlChars", () => {
  it("strips C0 control characters except tab and newline", () => {
    const esc = String.fromCharCode(0x1b); // ANSI ESC
    const nul = String.fromCharCode(0x00);
    const bel = String.fromCharCode(0x07);
    expect(stripControlChars(`a${esc}[31mb${nul}c${bel}d\te\nf`)).toBe("a[31mbcd\te\nf");
  });

  it("strips Unicode bidi controls", () => {
    const rlo = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
    const rle = String.fromCharCode(0x202b);
    expect(stripControlChars(`safe${rlo}gpj.exe${rle}x`)).toBe("safegpj.exex");
  });

  it("strips Unicode line/paragraph separators", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    expect(stripControlChars(`line1${ls}line2${ps}end`)).toBe("line1line2end");
  });

  it("leaves normal text unchanged", () => {
    expect(stripControlChars("hello world 123")).toBe("hello world 123");
  });
});

describe("stripNewlines", () => {
  it("strips \\r and \\n", () => {
    expect(stripNewlines("line1\nline2\r\nend")).toBe("line1line2end");
  });
});

describe("escapeBackticks", () => {
  it("escapes backticks", () => {
    expect(escapeBackticks("hello`world`")).toBe("hello\\`world\\`");
  });
});

describe("sanitizeInlineCode", () => {
  it("strips control chars, newlines, and escapes backticks", () => {
    const esc = String.fromCharCode(0x1b);
    expect(sanitizeInlineCode(`code\n${esc}[31m`)).toBe("code[31m");
    expect(sanitizeInlineCode("a`b`c")).toBe("a\\`b\\`c");
  });
});

describe("sanitizeMarkdownText", () => {
  it("escapes Markdown structural characters", () => {
    expect(sanitizeMarkdownText("a`b*c_d#e[f]g>h|i")).toBe("a\\`b\\*c\\_d\\#e\\[f\\]g\\>h\\|i");
  });

  it("strips control chars", () => {
    const esc = String.fromCharCode(0x1b);
    expect(sanitizeMarkdownText(`text${esc}[31m`)).toBe("text\\[31m");
  });
});

describe("sanitizePath", () => {
  it("strips control chars and newlines from paths", () => {
    const esc = String.fromCharCode(0x1b);
    expect(sanitizePath(`evil\n${esc}[31m`)).toBe("evil[31m");
  });
});
