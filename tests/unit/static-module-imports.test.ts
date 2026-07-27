import { describe, expect, it } from "vitest";
import { staticImportSpecifiers } from "../../scripts/static-module-imports.mjs";

/**
 * The SDK's "browser DOM entry has no Node builtin imports" assertion used a regex keyed on
 * `from "…"`. The side-effect form — `import "node:fs";` — has no `from`, so a bundle importing a
 * Node builtin for its side effects satisfied the assertion. Node's own parser does not have a
 * shape it fails to recognise.
 */

describe("static import extraction", () => {
  it("finds a side-effect import, which the regex missed", () => {
    expect(staticImportSpecifiers('import "node:fs";')).toEqual(["node:fs"]);
  });

  it.each([
    ['import fs from "node:fs";', ["node:fs"]],
    ['import { readFile } from "node:fs/promises";', ["node:fs/promises"]],
    ['import * as path from "node:path";', ["node:path"]],
    ['import fs, { readFile } from "node:fs";', ["node:fs"]],
    ['export { fileURLToPath } from "node:url";', ["node:url"]],
    ['export * from "node:os";', ["node:os"]],
    ['export * as os from "node:os";', ["node:os"]],
    ["import 'node:crypto';", ["node:crypto"]],
    ['import "node:fs";\nimport "node:path";', ["node:fs", "node:path"]],
  ])("extracts %j", (source, expected) => {
    expect(staticImportSpecifiers(source)).toEqual(expected);
  });

  it("finds imports the source spreads across lines", () => {
    expect(
      staticImportSpecifiers('import {\n  readFile,\n  writeFile,\n} from\n  "node:fs/promises";'),
    ).toEqual(["node:fs/promises"]);
  });

  it("does not report a specifier that is only a string literal", () => {
    expect(staticImportSpecifiers("const s = 'import \"node:fs\"';\nexport { s };")).toEqual([]);
  });

  it("does not report a specifier inside a comment", () => {
    expect(staticImportSpecifiers('// import "node:fs";\nexport const x = 1;')).toEqual([]);
  });

  it("does not report dynamic import, which is not a static module request", () => {
    // Documented scope, not an oversight: callers that care check for it separately.
    expect(staticImportSpecifiers('const fs = await import("node:fs");')).toEqual([]);
  });

  it("returns nothing for a module with no imports", () => {
    expect(staticImportSpecifiers("export const version = 1;")).toEqual([]);
  });

  it("throws on source that is not a module rather than reporting nothing", () => {
    expect(() => staticImportSpecifiers("const = ;")).toThrow(/did not parse/);
  });

  it("does not evaluate the source it parses", () => {
    // `SourceTextModule` parses without linking or evaluating. If it ran this, the process would
    // exit and the test would not return.
    expect(staticImportSpecifiers('process.exit(1);\nimport "node:fs";')).toEqual(["node:fs"]);
  });

  it("handles a module the size of a real bundle", () => {
    // `dist/dom.js` is tens of kilobytes; the child process must not truncate or time out on it.
    const filler = Array.from({ length: 20000 }, (_, index) => `const v${index} = ${index};`).join(
      "\n",
    );
    expect(
      staticImportSpecifiers(`import "node:fs";\n${filler}\nexport const done = true;`),
    ).toEqual(["node:fs"]);
  });
});
