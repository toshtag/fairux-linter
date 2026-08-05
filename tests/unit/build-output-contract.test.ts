import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PackageManifest } from "../../scripts/build-output-contract.d.mts";
import {
  auditPaths,
  CODE_ARTIFACT_SUFFIXES,
  classifyDeclaredTypeEntry,
  classifyPath,
  createBuildOutputContext,
  declaredTypeEntries,
  isWorkspaceDistPath,
  isWorkspaceSourcePath,
  toPosixPath,
} from "../../scripts/build-output-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * The real repository identities, discovered the way the checker discovers them.
 *
 * Classification is deliberately not decidable from a path alone: which `dist/` is a build
 * directory depends on which workspaces exist, and which `.mjs` is hand-written depends on what
 * the Git index tracks. Binding the tests to the real sets keeps them honest about both.
 */
const trackedFiles = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const HANDWRITTEN_ZONE =
  /^(?:scripts\/[^/]+|(?:packages|apps)\/[^/]+\/scripts\/.+)\.(?:mjs|d\.mts)$|^tests\/fixtures\/.+\.mjs$/;

const context = createBuildOutputContext({
  workspaceDirs: ["packages", "apps"].flatMap((group) =>
    readdirSync(resolve(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`),
  ),
  trackedHandwrittenSources: trackedFiles.filter((file) => HANDWRITTEN_ZONE.test(file)),
});

const classify = (file: string) => classifyPath(file, context);

describe("build output contract — source trees", () => {
  it("refuses the exact files issue #57 generated", () => {
    expect(classify("packages/core/src/index.d.ts")).toEqual({
      path: "packages/core/src/index.d.ts",
      zone: "source-tree",
      reason: "artifact-suffix",
      suffix: ".d.ts",
    });
    expect(classify("packages/rules/src/generated/reviewed-governance.d.ts")?.zone).toBe(
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
      expect(classify(file), file).not.toBeNull();
    }
  });

  it("matches the longest suffix so a declaration map is not reported as a declaration", () => {
    expect(classify("packages/core/src/index.d.ts.map")?.suffix).toBe(".d.ts.map");
    expect(classify("packages/core/src/index.js.map")?.suffix).toBe(".js.map");
    expect(classify("packages/core/src/index.d.mts.map")?.suffix).toBe(".d.mts.map");
  });

  it("orders the suffix list longest-first so the longest match always wins", () => {
    CODE_ARTIFACT_SUFFIXES.forEach((suffix, index) => {
      for (const later of CODE_ARTIFACT_SUFFIXES.slice(index + 1)) {
        expect(suffix.endsWith(later), `${suffix} must be listed before ${later}`).toBe(false);
      }
    });
  });

  it("allows hand-written sources", () => {
    for (const file of [
      "packages/core/src/index.ts",
      "packages/rules/src/consent/checked-checkbox.ts",
      "packages/rules/src/generated/reviewed-governance.ts",
      "apps/vscode-extension/src/extension.ts",
      "examples/rule-pack-author/src/index.ts",
    ]) {
      expect(classify(file), file).toBeNull();
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
      expect(isWorkspaceDistPath(file, context), file).toBe(true);
      expect(classify(file), file).toBeNull();
    }
  });

  it("refuses a dist directory that is not directly under a workspace", () => {
    // A `dist` segment anywhere used to be an unconditional pass. `.gitignore` ignores `dist/` at
    // any depth and biome.json honours it, so these leaks were invisible to git status and to the
    // post-build lint as well — the checker was the only thing that could have caught them.
    const cases: Array<[string, string]> = [
      ["packages/core/src/dist/index.d.ts", "outside-dist"],
      ["packages/core/src/dist/index.js", "outside-dist"],
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
      expect(isWorkspaceDistPath(file, context), file).toBe(false);
      expect(classify(file)?.zone, file).toBe(zone);
    }
  });

  it("keeps the zones mutually exclusive, so the verdict does not depend on ordering", () => {
    for (const file of [
      "packages/core/src/dist/index.d.ts",
      "packages/core/dist/src/index.d.ts",
      "packages/core/src/index.ts",
      "packages/core/dist/index.d.ts",
    ]) {
      expect(isWorkspaceSourcePath(file) && isWorkspaceDistPath(file, context), file).toBe(false);
    }
    // A bundler that preserves module structure may emit `dist/src/…`; that is still build output.
    expect(classify("packages/core/dist/src/index.d.ts")).toBeNull();
  });
});

describe("build output contract — an unauthorized dist rejects any file", () => {
  it("refuses everything below a dist that is not a real workspace's output directory", () => {
    // The last gate used to be a suffix list, so only *code* leaked into a stray `dist` was
    // caught. `apps/chrome-extension` genuinely emits `manifest.json` and `popup.html`, so a
    // mis-pointed copy step produced exactly the files this missed.
    for (const file of [
      "packages/not-a-workspace/dist/leak.json",
      "apps/not-a-workspace/dist/popup.html",
      "packages/sdk/scripts/dist/manifest.json",
      "packages/sdk/scripts/nested/dist/readme.txt",
      "tests/fixtures/demo/dist/data.json",
      "docs/dist/leak.css",
      "tmp/dist/blob.wasm",
      "packages/core/src/dist/schema.json",
      "examples/rule-pack-author/dist/package.json",
    ]) {
      const violation = classify(file);
      expect(violation?.reason, file).toBe("unauthorized-dist");
      expect(violation?.suffix, file).toBeUndefined();
      expect(classify(file.replace(/\//g, "\\"))?.reason, file).toBe("unauthorized-dist");
    }
  });

  it("allows any asset inside a real workspace's own dist", () => {
    for (const file of [
      "apps/chrome-extension/dist/manifest.json",
      "apps/chrome-extension/dist/popup.html",
      "apps/chrome-extension/dist/style.css",
      "packages/sdk/dist/package-metadata.json",
      "packages/core/dist/chunk.wasm",
    ]) {
      expect(classify(file), file).toBeNull();
    }
  });

  it("keeps naming the suffix when that is what was wrong", () => {
    expect(classify("packages/core/src/index.d.ts")).toEqual({
      path: "packages/core/src/index.d.ts",
      zone: "source-tree",
      reason: "artifact-suffix",
      suffix: ".d.ts",
    });
    expect(classify("packages/core/test/leak.mjs")?.reason).toBe("artifact-suffix");
  });
});

describe("build output contract — allowances follow real identities", () => {
  /** A deliberately small context, so the difference tracked/untracked is the only variable. */
  const small = createBuildOutputContext({
    workspaceDirs: ["packages/core", "apps/cli"],
    trackedHandwrittenSources: [
      "scripts/check-build-output.mjs",
      "packages/core/scripts/helper.mjs",
      "tests/fixtures/demo/consumer.mjs",
    ],
  });

  it("allows dist only under a workspace that actually exists", () => {
    for (const file of ["packages/core/dist/index.js", "apps/cli/dist/index.js"]) {
      expect(isWorkspaceDistPath(file, small), file).toBe(true);
      expect(classifyPath(file, small), file).toBeNull();
    }
    // Path shape alone used to be enough; a directory named like a workspace is not one.
    for (const file of [
      "packages/not-a-workspace/dist/leak.js",
      "packages/core-copy/dist/leak.js",
      "apps/not-a-workspace/dist/leak.d.ts",
      "apps/cli-copy/dist/leak.js",
      "packages/sdk/dist/leak.js",
      "packages/dist/leak.js",
      "apps/dist/leak.js",
    ]) {
      expect(isWorkspaceDistPath(file, small), file).toBe(false);
      expect(classifyPath(file, small)?.zone, file).toBe("outside-dist");
    }
  });

  it("allows a hand-written source only when that exact path is tracked", () => {
    for (const file of [
      "scripts/check-build-output.mjs",
      "packages/core/scripts/helper.mjs",
      "tests/fixtures/demo/consumer.mjs",
    ]) {
      expect(classifyPath(file, small), file).toBeNull();
    }
    // Same zone, same suffix, not tracked — so it is something the build produced.
    for (const file of [
      "scripts/generated.mjs",
      "packages/core/scripts/generated.mjs",
      "packages/core/scripts/generated.d.mts",
      "apps/cli/scripts/generated.mjs",
      "tests/fixtures/generated.mjs",
    ]) {
      expect(classifyPath(file, small)?.zone, file).toBe("outside-dist");
    }
  });

  it("refuses a dist nested inside a hand-written source zone, tracked or not", () => {
    const withNestedDist = createBuildOutputContext({
      workspaceDirs: ["packages/core"],
      // Even if such a path were somehow tracked, a `dist` segment disqualifies it.
      trackedHandwrittenSources: [
        "packages/core/scripts/dist/leak.mjs",
        "tests/fixtures/demo/dist/leak.mjs",
      ],
    });
    for (const file of [
      "packages/core/scripts/dist/leak.mjs",
      "packages/core/scripts/nested/dist/leak.d.mts",
      "tests/fixtures/demo/dist/leak.mjs",
    ]) {
      expect(classifyPath(file, withNestedDist)?.zone, file).toBe("outside-dist");
    }
  });

  it("refuses a script under a workspace that does not exist", () => {
    const ghost = createBuildOutputContext({
      workspaceDirs: ["packages/core"],
      trackedHandwrittenSources: ["packages/core/scripts/helper.mjs"],
    });
    for (const file of ["packages/ghost/scripts/helper.mjs", "apps/ghost/scripts/helper.mjs"]) {
      expect(classifyPath(file, ghost)?.zone, file).toBe("outside-dist");
    }
  });

  it("applies the same identities with Windows separators", () => {
    expect(isWorkspaceDistPath("packages\\core\\dist\\index.js", small)).toBe(true);
    expect(isWorkspaceDistPath("packages\\not-a-workspace\\dist\\leak.js", small)).toBe(false);
    expect(classifyPath("packages\\core\\scripts\\helper.mjs", small)).toBeNull();
    expect(classifyPath("packages\\core\\scripts\\generated.mjs", small)?.zone).toBe(
      "outside-dist",
    );
  });
});

describe("build output contract — outside dist", () => {
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
      expect(classify(file), file).toBeNull();
    }
  });

  it("classifies every checked-in runtime and declaration source as allowed", () => {
    // A hand-written list of paths passes even when the paths no longer exist — this suite carried
    // a reference to a deleted file for exactly that reason. Enumerate the real tree instead, so
    // the allowance is measured against what is actually committed.
    const tracked = trackedFiles.filter((file) => /\.(?:js|mjs|cjs|jsx|d\.mts|d\.cts)$/.test(file));

    expect(tracked.length).toBeGreaterThan(40);
    expect(tracked.filter((file) => classify(file) !== null)).toEqual([]);
    // Every one is tracked *and* inside an approved zone — no `dist` segment slipped in.
    expect(tracked.filter((file) => file.split("/").includes("dist"))).toEqual([]);
  });

  it("allows hand-written sources by location, not by extension", () => {
    // `.mjs` and `.d.mts` used to be allowed everywhere outside dist, which also admitted
    // `packages/core/test/dist/leak.mjs` and `docs/dist/leak.js`.
    for (const file of [
      "packages/core/test/leak.js",
      "packages/core/test/leak.mjs",
      "packages/core/test/leak.cjs",
      "packages/core/test/leak.jsx",
      "packages/core/test/leak.d.mts",
      "packages/core/test/leak.d.cts",
      "packages/core/test/dist/leak.js",
      "packages/core/test/dist/leak.mjs",
      "packages/core/test/dist/leak.d.mts",
      "packages/rules/test/fixture.mjs",
      "docs/dist/leak.js",
      "docs/dist/leak.mjs",
      "docs/dist/leak.d.cts",
      "docs/example.mjs",
      "tmp/output.cjs",
    ]) {
      expect(classify(file)?.zone, file).toBe("outside-dist");
      expect(classify(file.replace(/\//g, "\\"))?.zone, file).toBe("outside-dist");
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
      expect(classify(file)?.zone, file).toBe("outside-dist");
    }
  });

  it("still refuses unambiguous compiler output outside dist", () => {
    expect(classify("packages/rules/scripts/review-validation.d.ts")?.zone).toBe("outside-dist");
    expect(classify("tsconfig.tsbuildinfo")?.zone).toBe("outside-dist");
    expect(classify("packages/report/test/sarif.test.d.ts")?.zone).toBe("outside-dist");
  });

  it("ignores directories that are not ours to police", () => {
    for (const file of [
      "node_modules/@fairux/core/src/index.d.ts",
      "packages/core/node_modules/x/src/index.js",
      "coverage/src/index.js",
    ]) {
      expect(classify(file), file).toBeNull();
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
      expect(classify(file.replace(/\//g, "\\")), file).toEqual(classify(file));
    }
    expect(isWorkspaceDistPath("packages\\sdk\\dist\\index.d.ts", context)).toBe(true);
    expect(isWorkspaceDistPath("docs\\dist\\index.d.ts", context)).toBe(false);
  });
});

describe("build output contract — audit", () => {
  it("reports violations sorted and drops allowed paths", () => {
    const violations = auditPaths(
      [
        "packages/rules/src/index.js",
        "packages/sdk/dist/index.d.ts",
        "packages/core/src/index.d.ts",
        "packages/core/src/index.ts",
      ],
      context,
    );
    expect(violations.map((violation) => violation.path)).toEqual([
      "packages/core/src/index.d.ts",
      "packages/rules/src/index.js",
    ]);
  });

  it("passes a clean list", () => {
    expect(
      auditPaths(["packages/core/src/index.ts", "packages/core/dist/index.d.ts"], context),
    ).toEqual([]);
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
    // The CLI's shape: a real published field that is none of `types`, `typings`, or `exports`.
    // An empty object would check less — that a manifest with nothing in it yields nothing, rather
    // than that an unrelated field beside them is not mistaken for a declaration.
    //
    // Intersected rather than added to `PackageManifest`: `bin` is not something
    // `declaredTypeEntries` reads, and the production type should keep saying so.
    const cliManifest: PackageManifest & { readonly bin: { readonly fairux: string } } = {
      bin: { fairux: "./dist/index.js" },
    };
    // The unrelated field is the case. Asserted, so deleting `bin` to satisfy a compiler fails
    // here rather than quietly turning this into "an empty manifest declares nothing".
    const declarationFields = new Set(["types", "typings", "exports"]);
    expect(
      Object.keys(cliManifest).filter((field) => !declarationFields.has(field)),
    ).not.toHaveLength(0);
    expect(declaredTypeEntries(cliManifest)).toEqual([]);
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
