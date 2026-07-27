import { describe, expect, it } from "vitest";
import {
  deepEqual,
  expectedPackedManifest,
  INSTALL_TIME_SCRIPTS,
} from "../../scripts/expected-packed-manifest.mjs";

/**
 * The packed manifest used to be checked field by field, which left every unlisted field free.
 * Deriving the whole expected manifest instead only works if every transform the packer performs is
 * known — measured against `pnpm@10.33.2 pack` for both publishable packages, it performs two.
 */

const SOURCE = {
  name: "@fairux/sdk",
  version: "0.1.0-beta.2",
  scripts: {
    build: "tsdown",
    prepack: "pnpm build",
    prepublishOnly: "node guard.mjs",
    typecheck: "tsc --noEmit",
  },
  devDependencies: { "@fairux/core": "workspace:*", esbuild: "^0.28.1" },
  dependencies: { parse5: "8.0.0" },
};

const VERSIONS = { "@fairux/core": "0.0.0" };

const derive = (source = SOURCE, workspaceVersions = VERSIONS) =>
  expectedPackedManifest({ sourceManifest: source, workspaceVersions });

describe("expected packed manifest", () => {
  it("strips exactly the publish-lifecycle scripts", () => {
    expect(derive().manifest?.scripts).toEqual({ build: "tsdown", typecheck: "tsc --noEmit" });
  });

  it("resolves a workspace range to the referenced package's own version", () => {
    expect(derive().manifest?.devDependencies).toEqual({
      "@fairux/core": "0.0.0",
      esbuild: "^0.28.1",
    });
  });

  it("leaves concrete ranges alone", () => {
    expect(derive().manifest?.dependencies).toEqual({ parse5: "8.0.0" });
  });

  it("carries every other field through untouched", () => {
    const source = { ...SOURCE, os: ["linux"], exports: { ".": "./dist/index.js" } };
    expect(derive(source).manifest?.os).toEqual(["linux"]);
    expect(derive(source).manifest?.exports).toEqual({ ".": "./dist/index.js" });
  });

  it("does not invent a scripts field where the checkout has none", () => {
    const { scripts, ...withoutScripts } = SOURCE;
    expect(Object.hasOwn(derive(withoutScripts).manifest ?? {}, "scripts")).toBe(false);
  });

  it.each(INSTALL_TIME_SCRIPTS)("refuses %s in the checkout and derives nothing", (name) => {
    const source = { ...SOURCE, scripts: { ...SOURCE.scripts, [name]: "node evil.mjs" } };
    const result = derive(source);
    // Nothing may be derived from a disqualifying checkout — a caller must not get an expectation
    // it could compare against and pass.
    expect(result.manifest).toBeNull();
    expect(result.failures).toContain(`source manifest defines an install-time script: ${name}`);
  });

  it("includes prepublish, which npm deprecated but still runs on install", () => {
    expect(INSTALL_TIME_SCRIPTS).toContain("prepublish");
    expect(INSTALL_TIME_SCRIPTS).toContain("dependencies");
  });

  it.each(["workspace:^", "workspace:~", "workspace:1.0.0"])(
    "refuses the unmeasured workspace form %s rather than guessing",
    (range) => {
      const source = { ...SOURCE, dependencies: { "@fairux/core": range } };
      expect(derive(source).manifest).toBeNull();
      expect(derive(source).failures.join("\n")).toMatch(/unsupported workspace protocol form/);
    },
  );

  it("refuses a workspace dependency it cannot resolve", () => {
    const source = { ...SOURCE, dependencies: { "@fairux/ghost": "workspace:*" } };
    expect(derive(source).failures.join("\n")).toMatch(/no workspace version known/);
  });
});

describe("deep equality", () => {
  it.each([
    [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
    [{ a: { b: [1, 2] } }, { a: { b: [1, 2] } }, true],
    [{ a: 1 }, { a: 1, b: undefined }, false],
    [{ a: [1, 2] }, { a: [2, 1] }, false],
    [{ a: null }, { a: undefined }, false],
    [[1, 2], { 0: 1, 1: 2 }, false],
    ["1", 1, false],
  ])("compares %j and %j", (a, b, expected) => {
    expect(deepEqual(a, b)).toBe(expected);
  });
});
