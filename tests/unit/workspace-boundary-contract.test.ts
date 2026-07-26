import { describe, expect, it } from "vitest";
import {
  auditSourceText,
  classifyWorkspacePrivateSourceImport,
  resolveRelativeSpecifier,
  scanModuleSpecifiers,
  tokenize,
  workspaceOf,
} from "../../scripts/workspace-boundary-contract.mjs";

const IMPORTER = "packages/rules/src/probe.ts";
const RULES_TEST = "packages/rules/test/built-in-governance.test.ts";
const RULES_NESTED_SRC = "packages/rules/src/nested/helper.ts";

const audit = (source: string) => auditSourceText(IMPORTER, source);
const specifiers = (source: string) => scanModuleSpecifiers(source).map((found) => found.specifier);

describe("workspace boundary — module load detection", () => {
  it("finds every syntactic form that loads a module", () => {
    const forms: Array<[string, string, string]> = [
      ["static-import", 'import { x } from "../../core/src/index.js";', "static-import"],
      ["type import", 'import type { X } from "../../core/src/index.js";', "static-import"],
      ["default import", 'import x from "../../core/src/index.js";', "static-import"],
      ["namespace import", 'import * as x from "../../core/src/index.js";', "static-import"],
      ["side-effect", 'import "../../core/src/index.js";', "side-effect-import"],
      ["export named", 'export { x } from "../../core/src/index.js";', "export-from"],
      ["export star", 'export * from "../../core/src/index.js";', "export-from"],
      ["export star as", 'export * as x from "../../core/src/index.js";', "export-from"],
      ["dynamic", 'await import("../../core/src/index.js");', "dynamic-import"],
      ["require", 'require("../../core/src/index.js");', "require"],
      ["import equals", 'import x = require("../../core/src/index.js");', "require"],
    ];

    for (const [label, source, kind] of forms) {
      const found = scanModuleSpecifiers(source);
      expect(
        found.map((entry) => entry.specifier),
        label,
      ).toEqual(["../../core/src/index.js"]);
      expect(found[0]?.kind, label).toBe(kind);
    }
  });

  it("finds a specifier split across lines, which is legal in JS and TS", () => {
    const multiline: Array<[string, string]> = [
      ["dynamic import", 'const m = import(\n  "../../core/src/index.js"\n);'],
      ["require", 'const m = require(\n  "../../core/src/index.js"\n);'],
      ["import equals", 'import m = require(\n  "../../core/src/index.js"\n);'],
      ["static import", 'import {\n  x\n}\nfrom\n  "../../core/src/index.js";'],
      ["export from", 'export {\n  x\n}\nfrom\n  "../../core/src/index.js";'],
    ];

    for (const [label, source] of multiline) {
      expect(specifiers(source), label).toEqual(["../../core/src/index.js"]);
      expect(audit(source), label).toHaveLength(1);
    }
  });

  it("tolerates comments between the tokens of a clause", () => {
    expect(specifiers('import(\n  /* reason */\n  "../../core/src/index.js"\n);')).toEqual([
      "../../core/src/index.js",
    ]);
    expect(specifiers('export { x }\n  /* source */\n  from "../../core/src/index.js";')).toEqual([
      "../../core/src/index.js",
    ]);
  });

  it("accepts an expression-free template literal as a specifier", () => {
    expect(specifiers("const m = import(`../../core/src/index.js`);")).toEqual([
      "../../core/src/index.js",
    ]);
  });

  it("scans inside template expressions, which are code", () => {
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: these strings are the source
    // text under test — the `${…}` is the construct being exercised, not an interpolation mistake.
    expect(audit('const r = `${await import("../../core/src/index.js")}`;')).toHaveLength(1);
    expect(audit("const r = `a${`b${await import(`../../core/src/index.js`)}`}`;")).toHaveLength(1);
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of source-text fixtures
  });

  it("skips a template literal whose value is not statically known", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(specifiers("const m = import(`../../core/${name}/index.js`);")).toEqual([]);
  });
});

describe("workspace boundary — code that only looks like an import", () => {
  it("ignores import syntax inside an ordinary string", () => {
    const cases = [
      `const a = 'import "../../core/src/index.js"';`,
      `const b = "require('../../core/src/index.js')";`,
      `const c = 'export { x } from "../../core/src/index.js"';`,
      `const d = "import(\\"../../core/src/index.js\\")";`,
    ];
    for (const source of cases) expect(audit(source), source).toEqual([]);
  });

  it("ignores import syntax inside template raw text", () => {
    expect(audit('const c = `export { x } from "../../core/src/index.js"`;')).toEqual([]);
    expect(audit('const d = `docs:\n  import "../../core/src/index.js";\n`;')).toEqual([]);
    expect(audit('const g = String.raw`import "../../core/src/index.js"`;')).toEqual([]);
  });

  it("ignores import syntax inside comments", () => {
    expect(audit('// import "../../core/src/index.js";\nexport const x = 1;')).toEqual([]);
    expect(audit('/* require("../../core/src/index.js"); */\nexport const x = 1;')).toEqual([]);
    expect(audit('/**\n * import "../../core/src/index.js";\n */\nexport const x = 1;')).toEqual(
      [],
    );
  });

  it("ignores import syntax inside a regular expression literal", () => {
    expect(audit(String.raw`const e = /import\s+"\.\.\/\.\.\/core\/src\/index\.js"/;`)).toEqual([]);
  });

  it("reads a slash inside a regex character class as a regex, not a comment", () => {
    // This was a documented known limitation of the previous line-based scanner. It is now a
    // supported case: the regex is skipped, and a real violation after it is still caught.
    expect(audit("const f = /[//]/;\nexport const x = 1;")).toEqual([]);
    expect(audit('const f = /[//]/;\nimport "../../core/src/index.js";')).toHaveLength(1);
  });

  it("does not treat // inside a string literal as a comment", () => {
    // The repo has many `"https://…"` literals; a naive strip would eat the rest of the line.
    expect(
      audit('const refs = ["https://www.ftc.gov/x"];\nimport "../../core/src/index.js";'),
    ).toHaveLength(1);
    expect(tokenize('const url = "https://example.test/a//b";')[3]?.value).toBe(
      "https://example.test/a//b",
    );
  });

  it("does not mistake a value or property named from for a clause", () => {
    expect(audit('export const from = "../../core/src/index.js";')).toEqual([]);
    expect(audit('export const o = { from: "../../core/src/index.js" };')).toEqual([]);
    expect(audit('const path = "../../core/src/index.js";')).toEqual([]);
    expect(audit('expect(files).toContain("../../core/src/index.js");')).toEqual([]);
  });

  it("ignores a member call named require", () => {
    expect(audit('loader.require("../../core/src/index.js");')).toEqual([]);
  });
});

describe("workspace boundary — line numbers", () => {
  it("reports the line the specifier literal starts on", () => {
    expect(audit('const r = import(\n  "../../core/src/index.js"\n);')[0]?.line).toBe(2);
    expect(audit('import {\n  x\n}\nfrom\n  "../../core/src/index.js";')[0]?.line).toBe(5);
  });

  it("counts lines across comments, strings, templates, and regexes", () => {
    const source = [
      "/*", // 1
      " * a comment", // 2
      " */", // 3
      "const t = `line", // 4
      "still template`;", // 5
      "const r = /a[/]b/;", // 6
      "", // 7
      'import "../../core/src/index.js";', // 8
    ].join("\n");
    expect(audit(source)[0]?.line).toBe(8);
  });
});

describe("workspace boundary — resolution", () => {
  it("resolves relative specifiers against the importing file", () => {
    expect(resolveRelativeSpecifier(RULES_TEST, "../../core/src/index.js")).toBe(
      "packages/core/src/index.js",
    );
    expect(resolveRelativeSpecifier(RULES_NESTED_SRC, "../../../core/src/index.js")).toBe(
      "packages/core/src/index.js",
    );
    expect(resolveRelativeSpecifier(RULES_TEST, "./_util.js")).toBe("packages/rules/test/_util.js");
  });

  it("strips a query or fragment suffix rather than letting it evade the check", () => {
    expect(resolveRelativeSpecifier(RULES_TEST, "../../core/src/index.js?raw")).toBe(
      "packages/core/src/index.js",
    );
    expect(audit('import "../../core/src/index.js?raw";')).toHaveLength(1);
    expect(audit('import "../../core/src/index.js#frag";')).toHaveLength(1);
  });

  it("returns null for bare specifiers", () => {
    expect(resolveRelativeSpecifier(RULES_TEST, "@fairux/core")).toBeNull();
    expect(resolveRelativeSpecifier(RULES_TEST, "vitest")).toBeNull();
    expect(resolveRelativeSpecifier(RULES_TEST, "node:fs")).toBeNull();
  });

  it("does not crash when a specifier climbs past the repository root", () => {
    expect(resolveRelativeSpecifier(RULES_TEST, "../../../../../../etc/passwd")).toBe("etc/passwd");
    expect(audit(`${"../".repeat(50)}core/src/index.js`)).toEqual([]);
  });

  it("identifies the owning workspace", () => {
    expect(workspaceOf("packages/rules/test/x.ts")).toBe("packages/rules");
    expect(workspaceOf("apps/cli/src/index.ts")).toBe("apps/cli");
    expect(workspaceOf("scripts/check-build-output.mjs")).toBeNull();
  });
});

describe("workspace boundary — classification", () => {
  it("refuses a reach into another workspace's private source", () => {
    const cases = [
      [RULES_TEST, "../../core/src/index.js"],
      [RULES_TEST, "../../core/src"],
      [RULES_TEST, "../../core/src/jurisdiction.js"],
      [RULES_NESTED_SRC, "../../../core/src/index.js"],
      ["packages/report/test/sarif.test.ts", "../../rules/src/index.js"],
      ["apps/cli/src/index.ts", "../../../packages/core/src/index.js"],
    ] as const;

    for (const [importer, specifier] of cases) {
      expect(
        classifyWorkspacePrivateSourceImport(importer, specifier),
        `${importer} -> ${specifier}`,
      ).not.toBeNull();
    }
  });

  it("reports the resolved target, not the number of ../ segments", () => {
    expect(classifyWorkspacePrivateSourceImport(RULES_NESTED_SRC, "../../../core/src")).toEqual({
      specifier: "../../../core/src",
      resolved: "packages/core/src",
      importerWorkspace: "packages/rules",
      targetWorkspace: "packages/core",
    });
  });

  it("allows package-name imports and same-workspace relative imports", () => {
    const allowed = [
      [RULES_TEST, "@fairux/core"],
      [RULES_TEST, "vitest"],
      [RULES_TEST, "../src/index.js"],
      [RULES_NESTED_SRC, "../helpers.js"],
      [RULES_NESTED_SRC, "./sibling.js"],
      ["packages/core/src/scan.ts", "./types.js"],
      ["packages/rules/test/x.ts", "../reviews/built-in-rule-reviews.json"],
    ] as const;

    for (const [importer, specifier] of allowed) {
      expect(
        classifyWorkspacePrivateSourceImport(importer, specifier),
        `${importer} -> ${specifier}`,
      ).toBeNull();
    }
  });

  it("does not flag a reach into another workspace outside its src", () => {
    expect(classifyWorkspacePrivateSourceImport(RULES_TEST, "../../core/dist/index.js")).toBeNull();
    expect(classifyWorkspacePrivateSourceImport(RULES_TEST, "../../../docs/x.json")).toBeNull();
  });

  it("treats Windows importer paths identically", () => {
    expect(
      classifyWorkspacePrivateSourceImport("packages\\rules\\test\\x.ts", "../../core/src"),
    ).toEqual(classifyWorkspacePrivateSourceImport("packages/rules/test/x.ts", "../../core/src"));
  });
});

describe("workspace boundary — file audit", () => {
  it("catches every evasion found in review, in one file", () => {
    const source = [
      'import "../../core/src/index.js";',
      'const load = () => import("../../core/src/index.js");',
      'const cjs = require("../../core/src/index.js");',
      'import { isSemver } from "../../core/src";',
      'export { compareSemver } from "../../core/src/semver.js";',
      "const multiline = import(",
      '  "../../core/src/limits.js"',
      ");",
    ].join("\n");

    const violations = audit(source);
    expect(violations.map((violation) => violation.line)).toEqual([1, 2, 3, 4, 5, 7]);
    for (const violation of violations) {
      expect(violation.targetWorkspace).toBe("packages/core");
    }
  });

  it("passes a file that imports correctly", () => {
    const source = [
      'import { describe, it } from "vitest";',
      'import { isSemver } from "@fairux/core";',
      'import { helper } from "./helper.js";',
      'import catalog from "../../../docs/generated/rule-catalog.json" with { type: "json" };',
      'const doc = `import "../../core/src/index.js"`;',
      "const re = /[//]/;",
    ].join("\n");
    expect(auditSourceText("packages/rules/test/x.test.ts", source)).toEqual([]);
  });
});
