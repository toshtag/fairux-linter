import { describe, expect, it } from "vitest";
import {
  auditSourceText,
  classifyWorkspacePrivateSourceImport,
  extractModuleSpecifiers,
  resolveRelativeSpecifier,
  stripCommentsAndKeepLayout,
  workspaceOf,
} from "../../scripts/workspace-boundary-contract.mjs";

const RULES_TEST = "packages/rules/test/built-in-governance.test.ts";
const RULES_NESTED_SRC = "packages/rules/src/nested/helper.ts";

describe("workspace boundary — specifier extraction", () => {
  it("finds every form that loads another module", () => {
    expect(extractModuleSpecifiers('import { x } from "../../core/src/index.js";')).toContain(
      "../../core/src/index.js",
    );
    expect(extractModuleSpecifiers('export { x } from "../../core/src/index.js";')).toContain(
      "../../core/src/index.js",
    );
    expect(extractModuleSpecifiers('import "../../core/src/index.js";')).toContain(
      "../../core/src/index.js",
    );
    expect(extractModuleSpecifiers('await import("../../core/src/index.js");')).toContain(
      "../../core/src/index.js",
    );
    expect(extractModuleSpecifiers('require("../../core/src/index.js");')).toContain(
      "../../core/src/index.js",
    );
    expect(extractModuleSpecifiers('import x = require("../../core/src/index.js");')).toContain(
      "../../core/src/index.js",
    );
  });

  it("ignores a path that is only a value, not a module specifier", () => {
    expect(extractModuleSpecifiers('const path = "../../core/src/index.js";')).toEqual([]);
    expect(extractModuleSpecifiers('expect(files).toContain("../../core/src/index.js");')).toEqual(
      [],
    );
  });
});

describe("workspace boundary — comment handling", () => {
  it("blanks comments without touching string contents or line count", () => {
    const source = [
      '// import { x } from "../../core/src/index.js";',
      'const url = "https://example.test/a//b";',
      '/* import "../../core/src/index.js"; */',
      'import { y } from "@fairux/core";',
    ].join("\n");
    const stripped = stripCommentsAndKeepLayout(source);

    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped).toContain('"https://example.test/a//b"');
    expect(stripped).not.toContain("../../core/src/index.js");
    expect(stripped).toContain('import { y } from "@fairux/core";');
  });

  it("does not treat // inside a string literal as a comment", () => {
    // The repo has many `"https://…"` literals; a naive regex strip would eat the rest of the line.
    const source = 'const refs = ["https://www.ftc.gov/x"];\nimport "../../core/src/index.js";';
    expect(auditSourceText("packages/rules/src/x.ts", source)).toHaveLength(1);
  });

  it("ignores an import that appears only inside a comment", () => {
    const source = '// import "../../core/src/index.js";\nexport const x = 1;';
    expect(auditSourceText("packages/rules/src/x.ts", source)).toEqual([]);
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

  it("returns null for bare specifiers", () => {
    expect(resolveRelativeSpecifier(RULES_TEST, "@fairux/core")).toBeNull();
    expect(resolveRelativeSpecifier(RULES_TEST, "vitest")).toBeNull();
    expect(resolveRelativeSpecifier(RULES_TEST, "node:fs")).toBeNull();
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
      const violation = classifyWorkspacePrivateSourceImport(importer, specifier);
      expect(violation, `${importer} -> ${specifier}`).not.toBeNull();
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
  it("catches every evasion the first version of the guard missed", () => {
    const source = [
      'import "../../core/src/index.js";',
      'const load = () => import("../../core/src/index.js");',
      'const cjs = require("../../core/src/index.js");',
      'import { isSemver } from "../../core/src";',
      'export { compareSemver } from "../../core/src/semver.js";',
    ].join("\n");

    const violations = auditSourceText("packages/rules/src/probe.ts", source);
    expect(violations.map((violation) => violation.line)).toEqual([1, 2, 3, 4, 5]);
    for (const violation of violations) {
      expect(violation.targetWorkspace).toBe("packages/core");
    }
  });

  it("reports accurate line numbers past a block comment", () => {
    const source = ["/*", " * a comment", " */", "", 'import "../../core/src/index.js";'].join(
      "\n",
    );
    expect(auditSourceText("packages/rules/src/probe.ts", source)[0]?.line).toBe(5);
  });

  it("passes a file that imports correctly", () => {
    const source = [
      'import { describe, it } from "vitest";',
      'import { isSemver } from "@fairux/core";',
      'import { helper } from "./helper.js";',
      'import catalog from "../../../docs/generated/rule-catalog.json" with { type: "json" };',
    ].join("\n");
    expect(auditSourceText("packages/rules/test/x.test.ts", source)).toEqual([]);
  });
});
