import { describe, expect, it } from "vitest";
import { findDynamicModuleLoads } from "../../scripts/dynamic-module-loads.mjs";

/**
 * The SDK's browser entry was audited for Node builtins with a regex over `import(...)`. A comment
 * between the keyword and its argument defeated it — reproduced against the real SDK tarball:
 *
 *     export const x = import(/* webpackIgnore: true *\/ "node:fs");
 *
 * Widening the regex just invites `import(`node:fs`)` and `import("node:" + "fs")`. The browser
 * entry has no reason to load a module at runtime, so the specifier is never extracted at all.
 */

const finds = (source: string) => findDynamicModuleLoads(source).length;

describe("dynamic module loads — detected", () => {
  it.each([
    'import("node:fs")',
    'import ( "node:fs" )',
    'import(/* webpackIgnore: true */ "node:fs")',
    'import(\n  "node:fs"\n)',
    "import(`node:fs`)",
    'import("node:" + "fs")',
    "import(specifier)",
    'require("fs")',
    'require /* c */ ("fs")',
    'require\n("fs")',
    'import(// line comment\n"node:fs")',
    'const load = () => import("node:fs");',
    'export const x = import(/* a */ /* b */ "node:fs");',
  ])("finds %j", (source) => {
    expect(finds(source)).toBeGreaterThan(0);
  });

  it("reports each load site", () => {
    expect(finds('import("a"); import("b"); require("c");')).toBe(3);
  });

  it("names what it found", () => {
    expect(findDynamicModuleLoads('import("a"); require("b");').map((load) => load.kind)).toEqual([
      "import",
      "require",
    ]);
  });
});

describe("dynamic module loads — not a load", () => {
  it.each([
    "import.meta.url",
    "import.meta.resolve('x')",
    'import fs from "node:fs";',
    'import "node:fs";',
    'export { x } from "node:fs";',
    "const text = 'import(\"node:fs\")';",
    "const text = \"require('fs')\";",
    'const text = `import("node:fs")`;',
    '/* import("node:fs") */',
    '// import("node:fs")',
    'obj.require("fs")',
    'this.require("fs")',
    "importantThing(1)",
    "requireAuth(1)",
    "const imports = [1, 2];",
    "",
  ])("does not flag %j", (source) => {
    expect(finds(source)).toBe(0);
  });

  it("does not flag an escaped quote inside a string that looks like a load", () => {
    expect(finds('const s = "he said \\"import(\'node:fs\')\\"";')).toBe(0);
  });

  it("resumes scanning after a string literal ends", () => {
    expect(finds('const s = "safe"; import("node:fs");')).toBe(1);
  });

  it("resumes scanning after a comment ends", () => {
    expect(finds('/* import("a") */ import("b");')).toBe(1);
  });

  it("resumes scanning after an unterminated comment without hanging", () => {
    expect(finds('import("a"); /* unterminated')).toBe(1);
  });
});
