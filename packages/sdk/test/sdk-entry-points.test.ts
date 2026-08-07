import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SdkEntryPointError,
  sdkEntryPointSpecifiers,
  sdkEntryPoints,
} from "../scripts/sdk-entry-points.mjs";

/**
 * One reader for the set of published entry points.
 *
 * Five places knew the set and each had its own copy: the build config listed source files, the
 * build-output check listed dist basenames, the inventory generator listed specifiers with
 * declaration filenames, the release-notes generator froze the specifiers, and the consumer
 * boundary listed them again as an allowlist. They agreed because nobody had added a subpath
 * export — not because anything held them together.
 *
 * The cases below are the three shapes a manifest can be wrong in, plus the one judgement this
 * module makes: `./package.json` is exported for tooling and is not an API.
 */

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
) as { name: string; exports: Record<string, unknown> };

describe("SDK entry points — derived from the manifest", () => {
  it("maps each subpath to the specifier a consumer imports and the artifact the build emits", () => {
    expect(
      sdkEntryPoints({
        name: "@scope/pkg",
        exports: { ".": "./dist/index.js", "./html": "./dist/html.js" },
      }),
    ).toEqual([
      { subpath: ".", specifier: "@scope/pkg", base: "index" },
      { subpath: "./html", specifier: "@scope/pkg/html", base: "html" },
    ]);
  });

  it("excludes the tooling export", () => {
    // `require.resolve("@fairux/sdk/package.json")` is how a consumer asserts an installed version.
    // It is metadata, so it is not built, not in the inventory, and not announced in the notes.
    expect(
      sdkEntryPointSpecifiers({
        name: "@scope/pkg",
        exports: { ".": "./dist/index.js", "./package.json": "./package.json" },
      }),
    ).toEqual(["@scope/pkg"]);
  });

  it("preserves manifest order", () => {
    expect(
      sdkEntryPointSpecifiers({
        name: "@scope/pkg",
        exports: { "./dom": "./dist/dom.js", ".": "./dist/index.js" },
      }),
    ).toEqual(["@scope/pkg/dom", "@scope/pkg"]);
  });

  it("reads this package's own manifest", () => {
    expect(sdkEntryPointSpecifiers(manifest)).toContain(manifest.name);
    expect(sdkEntryPointSpecifiers(manifest)).not.toContain(`${manifest.name}/package.json`);
  });
});

describe("SDK entry points — what it refuses", () => {
  it.each([
    ["no package name", { exports: { ".": "./dist/index.js" } }],
    ["a non-string package name", { name: 42, exports: { ".": "./dist/index.js" } }],
    ["no exports", { name: "@scope/pkg" }],
    ["an exports array", { name: "@scope/pkg", exports: ["./dist/index.js"] }],
    ["only the tooling export", { name: "@scope/pkg", exports: { "./package.json": "./p.json" } }],
    ["a non-subpath export key", { name: "@scope/pkg", exports: { html: "./dist/html.js" } }],
  ])("refuses %s", (_label, broken) => {
    expect(() => sdkEntryPoints(broken)).toThrow(SdkEntryPointError);
  });

  it("refuses a subpath that does not map to a flat artifact name", () => {
    // The build-output check looks for `dist/<base>.js` and the inventory for `dist/<base>.d.ts`.
    // A nested subpath would have both looking in a directory the build never writes, so it is
    // refused here rather than silently mangled into something that resolves to nothing.
    expect(() =>
      sdkEntryPoints({ name: "@scope/pkg", exports: { "./a/b": "./dist/a/b.js" } }),
    ).toThrow(/flat dist artifact name/);
  });
});
