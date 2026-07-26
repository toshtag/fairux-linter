import { describe, expect, it } from "vitest";
import {
  auditPaths,
  classifyPath,
  declaredTypeEntries,
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
      "packages/dom/src/index.cjs",
      "apps/cli/src/index.jsx",
      "packages/html/src/tsconfig.tsbuildinfo",
    ]) {
      expect(classifyPath(file), file).not.toBeNull();
    }
  });

  it("matches the longest suffix so a declaration map is not reported as a declaration", () => {
    expect(classifyPath("packages/core/src/index.d.ts.map")?.suffix).toBe(".d.ts.map");
    expect(classifyPath("packages/core/src/index.js.map")?.suffix).toBe(".js.map");
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

describe("build output contract — outside dist", () => {
  it("treats everything under a dist directory as legitimate build output", () => {
    for (const file of [
      "packages/sdk/dist/index.d.ts",
      "packages/sdk/dist/index.d.ts.map",
      "apps/cli/dist/index.js.map",
      "packages/core/dist/index.js",
    ]) {
      expect(classifyPath(file), file).toBeNull();
    }
  });

  it("keeps the checked-in .mjs scripts and their ambient declarations", () => {
    for (const file of [
      "scripts/check-build-output.mjs",
      "scripts/build-output-contract.d.mts",
      "packages/rules/scripts/generate-rule-catalog.mjs",
      "packages/rules/scripts/review-validation.d.mts",
      "packages/sdk/scripts/npm-registry-state.d.mts",
      "tests/fixtures/sdk-node-consumer/consumer.mjs",
      "tests/fixtures/sdk-custom-rule-pack/valid/minimal-pack.mjs",
    ]) {
      expect(classifyPath(file), file).toBeNull();
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
    expect(classifyPath("packages\\core\\src\\index.d.ts")).toEqual(
      classifyPath("packages/core/src/index.d.ts"),
    );
    expect(classifyPath("packages\\sdk\\dist\\index.d.ts")).toBeNull();
    expect(classifyPath("node_modules\\x\\src\\index.d.ts")).toBeNull();
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

  it("returns nothing for a package that publishes no declarations", () => {
    expect(declaredTypeEntries({ bin: { fairux: "./dist/index.js" } })).toEqual([]);
  });
});
