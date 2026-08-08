import { describe, expect, it } from "vitest";
import { forbiddenReason } from "../../scripts/check-runtime-safety.mjs";
import { moduleSpecifiers } from "../../scripts/module-specifiers.mjs";

/**
 * What the browser-safety check counts as loading a module.
 *
 * It scanned line by line with a regular expression, and each of these reached `exit 0` on a real
 * run against `packages/core/src`:
 *
 *     const fs = require("fs");
 *     import /* keep *\/ "node:fs";
 *     const fs = await import(
 *       "node:fs"
 *     );
 *
 * The round before this one added three import forms and covered the one-line spelling of each,
 * which is not the same as covering the forms. These cases exist so the next round cannot repeat
 * that: every way a specifier is written is here, alongside the strings and comments that must not
 * be mistaken for one.
 */

const loads = (source: string) => moduleSpecifiers(source).map((entry) => entry.specifier);
const refused = (source: string) =>
  moduleSpecifiers(source).filter((entry) => forbiddenReason(entry.specifier) !== undefined);

describe("what counts as loading a module", () => {
  it.each([
    ["a named import", 'import { readFileSync } from "node:fs";'],
    ["a default import", 'import fs from "node:fs";'],
    ["a namespace import", 'import * as fs from "node:fs";'],
    ["a side-effect import", 'import "node:fs";'],
    ["a re-export", 'export { readFileSync } from "node:fs";'],
    ["a star re-export", 'export * from "node:fs";'],
    ["a dynamic import", 'const fs = await import("node:fs");'],
    ["a dynamic import split across lines", 'const fs = await import(\n  "node:fs"\n);'],
    ["an import interrupted by a comment", 'import /* keep */ "node:fs";'],
    ["a from-clause interrupted by a comment", 'import x from /* keep */ "node:fs";'],
    ["a require of a prefixed builtin", 'const fs = require("node:fs");'],
    ["a require of a bare builtin", 'const fs = require("fs");'],
    ["import-equals-require", 'import fs = require("node:fs");'],
    ["single quotes", "import 'node:fs';"],
    ["an import on its own lines", 'import\n  "node:fs";'],
  ])("refuses %s", (_label, source) => {
    expect(refused(source), source).toHaveLength(1);
  });

  it.each([
    ["a string that looks like one", "const example = \"import('node:fs')\";"],
    ["a require inside a string", 'const example = "require(\\"fs\\")";'],
    ["a line comment", '// import "node:fs" is what this must never do'],
    ["a block comment", '/* const fs = require("fs"); */'],
    ["a doc comment naming the module", "/**\n * `node:fs` is forbidden here.\n */"],
    ["prose in a template literal", 'const help = `use require("fs") in an adapter`;'],
  ])("does not refuse %s", (_label, source) => {
    expect(refused(source), source).toEqual([]);
  });

  it("allows what a browser-safe package may load", () => {
    const source = [
      'import { scan } from "@fairux/core";',
      'import type { Rule } from "../types.js";',
      'export * from "./dictionary.js";',
    ].join("\n");
    expect(refused(source)).toEqual([]);
    expect(loads(source)).toEqual(["@fairux/core", "../types.js", "./dictionary.js"]);
  });

  it("reports the line the specifier is on, not the line the statement started", () => {
    const source = 'const a = 1;\nconst fs = await import(\n  "node:fs"\n);';
    expect(moduleSpecifiers(source)).toEqual([{ specifier: "node:fs", line: 3 }]);
  });

  it("does not lose a real import that follows a comment containing one", () => {
    // The failure a blanking pass gets wrong in the other direction: a comment must not swallow the
    // code after it.
    const source = '// import "node:fs"\nimport { readFileSync } from "node:fs";';
    expect(refused(source)).toHaveLength(1);
  });
});
