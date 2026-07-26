import { describe, expect, it } from "vitest";
import {
  auditPaths,
  classifyDeclaredTypeEntry,
  classifyPath,
  declaredTypeEntries,
  isWorkspaceDistPath,
  isWorkspaceSourcePath,
  SOURCE_TREE_FORBIDDEN_SUFFIXES,
  STRAY_ARTIFACT_SUFFIXES,
  toPosixPath,
} from "../../scripts/build-output-contract.mjs";

describe("build output contract — source trees", () => {
  it("refuses the exact files issue #57 generated", () => {
    expect(classifyPath("packages/core/src/index.d.ts")).toEqual({
      path: "packages/core/src/index.d.ts",
      zone: "source-tree",
      suffix: ".d.ts",
    });
    expect(classifyPath("packages/rules/src/generated/reviewed-governance.d.ts")?.zone).toBe(
      "source-tree",
    );
  });

  it("refuses declaration maps, sourcemaps, and emitted JS alongside sources", () => {
    for (const file of [
      "packages/core/src/index.d.ts.map",
      "packages/core/src/index.js",
      "packages/core/src/index.js.map",
      "packages/dom/src/index.mjs",
      "packages/dom/src/index.mjs.map",
      "packages/dom/src/index.cjs",
      "packages/dom/src/index.cjs.map",
      "packages/core/src/index.d.mts.map",
      "packages/core/src/index.d.cts.map",
      "apps/cli/src/index.jsx",
      "packages/html/src/tsconfig.tsbuildinfo",
      "examples/rule-pack-author/src/index.js",
    ]) {
      expect(classifyPath(file), file).not.toBeNull();
    }
  });

  it("matches the longest suffix so a declaration map is not reported as a declaration", () => {
    expect(classifyPath("packages/core/src/index.d.ts.map")?.suffix).toBe(".d.ts.map");
    expect(classifyPath("packages/core/src/index.js.map")?.suffix).toBe(".js.map");
    expect(classifyPath("packages/core/src/index.d.mts.map")?.suffix).toBe(".d.mts.map");
  });

  it("orders both suffix lists longest-first so the longest match always wins", () => {
    for (const suffixes of [SOURCE_TREE_FORBIDDEN_SUFFIXES, STRAY_ARTIFACT_SUFFIXES]) {
      suffixes.forEach((suffix, index) => {
        for (const later of suffixes.slice(index + 1)) {
          expect(suffix.endsWith(later), `${suffix} must be listed before ${later}`).toBe(false);
        }
      });
    }
  });

  it("allows hand-written sources", () => {
    for (const file of [
      "packages/core/src/index.ts",
      "packages/rules/src/consent/checked-checkbox.ts",
      "packages/rules/src/generated/reviewed-governance.ts",
      "apps/vscode-extension/src/extension.ts",
      "examples/rule-pack-author/src/index.ts",
    ]) {
      expect(classifyPath(file), file).toBeNull();
    }
  });
});

describe("build output contract — only a direct workspace dist is a build directory", () => {
  it("allows artifacts only under a direct workspace dist directory", () => {
    for (const file of [
      "packages/sdk/dist/index.d.ts",
      "packages/sdk/dist/index.d.ts.map",
      "packages/sdk/dist/src-CAILcJf_.js",
      "packages/core/dist/nested/index.d.ts",
      "apps/cli/dist/index.js.map",
      "apps/cli/dist/index.js",
    ]) {
      expect(isWorkspaceDistPath(file), file).toBe(true);
      expect(classifyPath(file), file).toBeNull();
    }
  });

  it("refuses a dist directory that is not directly under a workspace", () => {
    // A `dist` segment anywhere used to be an unconditional pass. `.gitignore` ignores `dist/` at
    // any depth and biome.json honours it, so these leaks were invisible to git status and to the
    // post-build lint as well — the checker was the only thing that could have caught them.
    const cases: Array<[string, string]> = [
      ["packages/core/src/dist/index.d.ts", "source-tree"],
      ["packages/core/src/dist/index.js", "source-tree"],
      ["packages/core/test/dist/index.d.ts", "outside-dist"],
      ["packages/core/nested/dist/index.d.ts", "outside-dist"],
      ["packages/dist/index.d.ts", "outside-dist"],
      ["apps/dist/index.d.ts", "outside-dist"],
      ["docs/dist/index.d.ts", "outside-dist"],
      ["dist/index.d.ts", "outside-dist"],
      ["tmp/dist/index.d.ts", "outside-dist"],
      ["examples/rule-pack-author/dist/index.d.ts", "outside-dist"],
    ];
    for (const [file, zone] of cases) {
      expect(isWorkspaceDistPath(file), file).toBe(false);
      expect(classifyPath(file)?.zone, file).toBe(zone);
    }
  });

  it("keeps the zones mutually exclusive, so the verdict does not depend on ordering", () => {
    for (const file of [
      "packages/core/src/dist/index.d.ts",
      "packages/core/dist/src/index.d.ts",
      "packages/core/src/index.ts",
      "packages/core/dist/index.d.ts",
    ]) {
      expect(isWorkspaceSourcePath(file) && isWorkspaceDistPath(file), file).toBe(false);
    }
    // A bundler that preserves module structure may emit `dist/src/…`; that is still build output.
    expect(classifyPath("packages/core/dist/src/index.d.ts")).toBeNull();
  });
});

describe("build output contract — outside dist", () => {
  it("keeps the checked-in .mjs scripts and their ambient declarations", () => {
    for (const file of [
      "scripts/check-build-output.mjs",
      "scripts/build-output-contract.d.mts",
      "scripts/workspace-boundary-contract.d.mts",
      "packages/rules/scripts/generate-rule-catalog.mjs",
      "packages/rules/scripts/review-validation.d.mts",
      "packages/sdk/scripts/npm-registry-state.d.mts",
      "tests/fixtures/sdk-node-consumer/consumer.mjs",
      "tests/fixtures/sdk-custom-rule-pack/valid/minimal-pack.mjs",
    ]) {
      expect(classifyPath(file), file).toBeNull();
    }
  });

  it("refuses their sourcemaps, which nothing here hand-writes", () => {
    for (const file of [
      "packages/core/test/leak.d.mts.map",
      "packages/core/test/leak.d.cts.map",
      "packages/rules/scripts/review-validation.mjs.map",
      "packages/rules/scripts/review-validation.cjs.map",
      "scripts/check-build-output.js.map",
    ]) {
      expect(classifyPath(file)?.zone, file).toBe("outside-dist");
    }
  });

  it("still refuses unambiguous compiler output outside dist", () => {
    expect(classifyPath("packages/rules/scripts/review-validation.d.ts")?.zone).toBe(
      "outside-dist",
    );
    expect(classifyPath("tsconfig.tsbuildinfo")?.zone).toBe("outside-dist");
    expect(classifyPath("packages/report/test/sarif.test.d.ts")?.zone).toBe("outside-dist");
  });

  it("ignores directories that are not ours to police", () => {
    for (const file of [
      "node_modules/@fairux/core/src/index.d.ts",
      "packages/core/node_modules/x/src/index.js",
      "coverage/src/index.js",
      ".code-pact/state/src/index.d.ts",
    ]) {
      expect(classifyPath(file), file).toBeNull();
    }
  });
});

describe("build output contract — path normalization", () => {
  it("classifies Windows separators identically to POSIX", () => {
    expect(toPosixPath("packages\\core\\src\\index.d.ts")).toBe("packages/core/src/index.d.ts");
    for (const file of [
      "packages/core/src/index.d.ts",
      "packages/sdk/dist/index.d.ts",
      "packages/core/src/dist/index.d.ts",
      "docs/dist/index.d.ts",
      "node_modules/x/src/index.d.ts",
    ]) {
      expect(classifyPath(file.replace(/\//g, "\\")), file).toEqual(classifyPath(file));
    }
    expect(isWorkspaceDistPath("packages\\sdk\\dist\\index.d.ts")).toBe(true);
    expect(isWorkspaceDistPath("docs\\dist\\index.d.ts")).toBe(false);
  });
});

describe("build output contract — audit", () => {
  it("reports violations sorted and drops allowed paths", () => {
    const violations = auditPaths([
      "packages/rules/src/index.js",
      "packages/sdk/dist/index.d.ts",
      "packages/core/src/index.d.ts",
      "packages/core/src/index.ts",
    ]);
    expect(violations.map((violation) => violation.path)).toEqual([
      "packages/core/src/index.d.ts",
      "packages/rules/src/index.js",
    ]);
  });

  it("passes a clean list", () => {
    expect(auditPaths(["packages/core/src/index.ts", "packages/core/dist/index.d.ts"])).toEqual([]);
  });
});

describe("build output contract — declared type entry points", () => {
  it("collects types from the manifest root and every exports condition", () => {
    expect(
      declaredTypeEntries({
        types: "./dist/index.d.ts",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./html": { types: "./dist/html.d.ts", import: "./dist/html.js" },
          "./dom": { types: "./dist/dom.d.ts", import: "./dist/dom.js" },
          "./package.json": "./package.json",
        },
      }),
    ).toEqual(["dist/dom.d.ts", "dist/html.d.ts", "dist/index.d.ts"]);
  });

  it("does not silently drop an entry that omits the ./ prefix", () => {
    expect(declaredTypeEntries({ types: "dist/index.d.ts" })).toEqual(["dist/index.d.ts"]);
    expect(declaredTypeEntries({ types: "src/index.d.ts" })).toEqual(["src/index.d.ts"]);
  });

  it("returns nothing for a package that publishes no declarations", () => {
    expect(declaredTypeEntries({ bin: { fairux: "./dist/index.js" } })).toEqual([]);
  });

  it("requires every declared type entry to point into the package's own dist", () => {
    expect(classifyDeclaredTypeEntry("./dist/index.d.ts")).toBeNull();
    expect(classifyDeclaredTypeEntry("dist/html.d.ts")).toBeNull();
    expect(classifyDeclaredTypeEntry("./src/index.d.ts")).toBe("is not under dist/");
    expect(classifyDeclaredTypeEntry("./types/index.d.mts")).toBe("is not under dist/");
    expect(classifyDeclaredTypeEntry("index.d.ts")).toBe("is not under dist/");
    expect(classifyDeclaredTypeEntry("../other/dist/index.d.ts")).toBe(
      "escapes the package directory",
    );
  });
});
