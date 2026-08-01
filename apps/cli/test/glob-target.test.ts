import { describe, expect, it } from "vitest";
import {
  globMagicIndex,
  isGlobPattern,
  isUncPattern,
  toPortableGlobPattern,
} from "../src/glob-target.js";

/**
 * Every rule here names the platform it describes, so a macOS or Linux host settles the Windows
 * half too. What a host cannot settle from here is whether the expander then finds the files —
 * that is the CLI's own end-to-end cases, and on Windows the packed smoke's installed-CLI contract.
 */
describe("globMagicIndex", () => {
  it("finds the first character that makes a target a pattern", () => {
    expect(globMagicIndex("inputs/*.html")).toBe(7);
    expect(globMagicIndex("pages/**/index.html")).toBe(6);
    expect(globMagicIndex("a?.html")).toBe(1);
    expect(globMagicIndex("[ab].html")).toBe(0);
    expect(globMagicIndex("{a,b}.html")).toBe(0);
  });

  it("reports -1 for a target with no glob magic", () => {
    expect(globMagicIndex("inputs/page.html")).toBe(-1);
    expect(globMagicIndex("inputs\\page.html")).toBe(-1);
    expect(globMagicIndex("")).toBe(-1);
  });
});

describe("isGlobPattern", () => {
  it("recognises magic on either separator", () => {
    expect(isGlobPattern("inputs/*.html")).toBe(true);
    expect(isGlobPattern("inputs\\*.html")).toBe(true);
    expect(isGlobPattern("C:\\path\\*.html")).toBe(true);
  });

  it("does not treat a plain path as a pattern", () => {
    expect(isGlobPattern("inputs/page.html")).toBe(false);
    expect(isGlobPattern("C:\\path\\page.html")).toBe(false);
  });
});

describe("isUncPattern", () => {
  it("recognises the three Windows two-separator forms", () => {
    expect(isUncPattern("\\\\server\\share\\*.html", "win32")).toBe(true);
    expect(isUncPattern("//server/share/*.html", "win32")).toBe(true);
    expect(isUncPattern("\\\\?\\C:\\path\\*.html", "win32")).toBe(true);
    expect(isUncPattern("\\\\.\\pipe\\*", "win32")).toBe(true);
  });

  it("leaves ordinary Windows targets alone", () => {
    expect(isUncPattern("inputs\\*.html", "win32")).toBe(false);
    expect(isUncPattern("C:\\path\\*.html", "win32")).toBe(false);
    expect(isUncPattern("\\inputs\\*.html", "win32")).toBe(false);
    expect(isUncPattern("\\\\", "win32")).toBe(false);
  });

  it("never fires off Windows, where a leading // is an ordinary absolute path", () => {
    expect(isUncPattern("//server/share/*.html", "linux")).toBe(false);
    expect(isUncPattern("\\\\server\\share\\*.html", "darwin")).toBe(false);
  });
});

describe("toPortableGlobPattern", () => {
  it("translates every backslash on Windows", () => {
    expect(toPortableGlobPattern("inputs\\*.html", "win32")).toBe("inputs/*.html");
    expect(toPortableGlobPattern("C:\\path\\*.html", "win32")).toBe("C:/path/*.html");
    expect(toPortableGlobPattern("src\\**\\*.tsx", "win32")).toBe("src/**/*.tsx");
    expect(toPortableGlobPattern(".\\inputs\\*.html", "win32")).toBe("./inputs/*.html");
  });

  it("leaves an already portable Windows pattern unchanged", () => {
    expect(toPortableGlobPattern("inputs/*.html", "win32")).toBe("inputs/*.html");
  });

  it("keeps the escape meaning of a backslash everywhere else", () => {
    expect(toPortableGlobPattern("a\\*.html", "linux")).toBe("a\\*.html");
    expect(toPortableGlobPattern("a\\*.html", "darwin")).toBe("a\\*.html");
    expect(toPortableGlobPattern("inputs\\*.html", "freebsd")).toBe("inputs\\*.html");
  });
});
