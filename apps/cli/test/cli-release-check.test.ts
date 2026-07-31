import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditCliReleaseManifest,
  CLI_NODE_ENGINES,
  CLI_PREPUBLISH_GUARD,
  CLI_PUBLISHED_FILES,
  CLI_REPOSITORY_GIT_URL,
  CLI_REPOSITORY_HTTPS_URL,
} from "../scripts/cli-release-contract.mjs";
import { CLI_REPOSITORY_URL } from "../scripts/release-notes.mjs";

/**
 * The manifest half of the release contract.
 *
 * `publish-cli.yml` used to assert only that the tag matched the version. Whether the checkout
 * built `fairux` at all, and whether `fairux` was publishable, were first checked by the packed
 * tarball audit — after an install and a pack had already run. `publish-sdk.yml` asserts both in
 * `validate`; these are the assertions that let the CLI workflow do the same.
 *
 * The checked-in manifest is audited too, so this file fails if the package drifts out of the
 * contract rather than only if the contract is misused.
 */

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(cliDir, "package.json"), "utf8")) as Record<
  string,
  unknown
>;

/** The real manifest with one field replaced — so each case differs in exactly one thing. */
function mutated(overrides: Record<string, unknown>) {
  return { ...structuredClone(manifest), ...overrides };
}

describe("the checked-in CLI manifest", () => {
  it("satisfies the release contract", () => {
    expect(auditCliReleaseManifest({ manifest })).toEqual([]);
  });

  it("satisfies it under the tag that would release it", () => {
    expect(auditCliReleaseManifest({ manifest, tag: `v${manifest.version as string}` })).toEqual(
      [],
    );
  });

  it.each([
    ["repository missing", { repository: undefined }],
    ["repository as npm's string shorthand", { repository: "github:toshtag/fairux-linter" }],
    [
      "repository.type not git",
      {
        repository: {
          type: "hg",
          url: "git+https://github.com/toshtag/fairux-linter.git",
          directory: "apps/cli",
        },
      },
    ],
    // The one that reached the notes generator after `npm publish`.
    [
      "repository.url pointing elsewhere",
      {
        repository: {
          type: "git",
          url: "git+https://github.com/example/other.git",
          directory: "apps/cli",
        },
      },
    ],
    ["homepage pointing elsewhere", { homepage: "https://example.invalid" }],
    ["bugs as a string", { bugs: "https://github.com/toshtag/fairux-linter/issues" }],
    ["bugs.url pointing elsewhere", { bugs: { url: "https://example.invalid/issues" } }],
  ])("refuses a manifest with %s", (_label, override) => {
    expect(auditCliReleaseManifest({ manifest: mutated(override) }).length).toBeGreaterThan(0);
  });

  it("catches a drifted repository before the notes generator does", () => {
    // The manifest audit runs in PR CI and in `prepare`; the notes generator runs in the
    // privileged job. Before this, only the second knew the repository URL — so a drifted
    // manifest passed every pre-publish gate and failed after the version had been spent.
    const drifted = mutated({
      repository: {
        type: "git",
        url: "git+https://github.com/example/other.git",
        directory: "apps/cli",
      },
    });
    expect(auditCliReleaseManifest({ manifest: drifted })).toEqual([
      expect.stringContaining("repository.url must be"),
    ]);
  });

  it("carries the exact constants the contract pins", () => {
    // The manifest and the constants move together or not at all: a Node support-policy change is
    // a pull request that edits both and says why, not a manifest edit that the audit follows.
    expect((manifest.engines as { node: string }).node).toBe(CLI_NODE_ENGINES);
    expect((manifest.scripts as { prepublishOnly: string }).prepublishOnly).toBe(
      CLI_PREPUBLISH_GUARD,
    );
    // One source for the repository, so the notes generator and this audit cannot disagree.
    expect((manifest.repository as { url: string }).url).toBe(CLI_REPOSITORY_GIT_URL);
    expect(CLI_REPOSITORY_URL).toBe(CLI_REPOSITORY_HTTPS_URL);
  });

  it("declares its workspace siblings only as dev dependencies", () => {
    // The published manifest may carry no `workspace:` anywhere; the source manifest legitimately
    // carries them in `devDependencies`, because pnpm strips those when it packs. Asserting the
    // split here keeps the source-side rule from being quietly widened to match the packed one.
    const dev = JSON.stringify(manifest.devDependencies ?? {});
    expect(dev).toContain("workspace:");
    for (const map of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      expect(JSON.stringify(manifest[map] ?? {})).not.toContain("workspace:");
    }
  });
});

describe("auditCliReleaseManifest", () => {
  it.each([
    ["true", true],
    // The one the old `=== true` test let through, while the comment beside it claimed otherwise.
    // npm reads any truthy `private` as private, and a manifest whose publishability depends on
    // how a value coerces is not one this release path should be reasoning about.
    ['the string "false"', "false"],
    ['the string "true"', "true"],
    ["0", 0],
    ["null", null],
    ["an object", {}],
    ["an array", []],
  ])("refuses a private field of %s", (_label, value) => {
    expect(auditCliReleaseManifest({ manifest: mutated({ private: value }) })).toContainEqual(
      expect.stringContaining("private must be absent or the boolean false"),
    );
  });

  it("accepts private absent or explicitly false", () => {
    const withoutPrivate = mutated({});
    delete withoutPrivate.private;
    expect(auditCliReleaseManifest({ manifest: withoutPrivate })).toEqual([]);
    expect(auditCliReleaseManifest({ manifest: mutated({ private: false }) })).toEqual([]);
  });

  it("refuses a package that is not fairux", () => {
    expect(auditCliReleaseManifest({ manifest: mutated({ name: "@fairux/sdk" }) })).toEqual([
      expect.stringContaining('name must be "fairux"'),
    ]);
  });

  it("refuses a missing bin", () => {
    expect(auditCliReleaseManifest({ manifest: mutated({ bin: {} }) })).toEqual([
      expect.stringContaining("bin.fairux"),
    ]);
  });

  it("refuses a bin pointing somewhere else", () => {
    expect(
      auditCliReleaseManifest({ manifest: mutated({ bin: { fairux: "./src/index.ts" } }) }),
    ).toEqual([expect.stringContaining("bin.fairux")]);
  });

  it("refuses a widened files allowlist", () => {
    expect(
      auditCliReleaseManifest({ manifest: mutated({ files: [...CLI_PUBLISHED_FILES, "src"] }) }),
    ).toEqual([expect.stringContaining("files must be exactly")]);
  });

  it.each([
    ["a string", "not-an-object"],
    ["an array", []],
    ["null", null],
    ["a number", 1],
    ["a boolean", true],
  ])("refuses a dependencies field that is %s", (_label, dependencies) => {
    // `Object.entries("not-an-object")` enumerates the string's characters and
    // `Object.entries([])` is empty, so both walked cleanly through the workspace check and
    // reported nothing — in a contract whose whole point is exactness.
    expect(auditCliReleaseManifest({ manifest: mutated({ dependencies }) })).toContainEqual(
      expect.stringContaining("dependencies must be an object of name → range"),
    );
  });

  it.each(["optionalDependencies", "peerDependencies", "devDependencies"])(
    "refuses a %s field that is not an object",
    (map) => {
      expect(auditCliReleaseManifest({ manifest: mutated({ [map]: [] }) })).toContainEqual(
        expect.stringContaining(`${map} must be an object of name → range`),
      );
    },
  );

  it.each([
    ["null", null],
    ["a number", 1],
    ["a boolean", false],
    ["an object", {}],
    ["an array", []],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("refuses a dependency range that is %s", (_label, range) => {
    expect(
      auditCliReleaseManifest({
        manifest: mutated({
          dependencies: { ...(manifest.dependencies as object), commander: range },
        }),
      }),
    ).toContainEqual(expect.stringContaining("must be a non-empty range string"));
  });

  it("checks devDependencies ranges too, while still allowing workspace links there", () => {
    // pnpm strips dev dependencies when it packs, so a workspace link is legitimate — but a
    // malformed one is still malformed.
    expect(
      auditCliReleaseManifest({
        manifest: mutated({ devDependencies: { "@fairux/core": "workspace:*" } }),
      }),
    ).toEqual([]);
    expect(
      auditCliReleaseManifest({ manifest: mutated({ devDependencies: { "@fairux/core": null } }) }),
    ).toContainEqual(expect.stringContaining("must be a non-empty range string"));
  });

  it("refuses a workspace specifier in a published dependency map", () => {
    expect(
      auditCliReleaseManifest({
        manifest: mutated({ dependencies: { "@fairux/core": "workspace:*" } }),
      }),
    ).toContain(
      "dependencies.@fairux/core is a workspace specifier and would not resolve for a consumer",
    );
  });

  it.each([
    ["", ""],
    ["echo ok", "echo ok"],
    // The same script with its exit status thrown away — the guard runs and refuses nothing.
    ["the guard with || true", "node scripts/prepublish-guard.mjs || true"],
    ["a different script", "node other-script.mjs"],
    ["an array", []],
    ["an object", {}],
  ])("refuses a prepublishOnly of %s", (_label, value) => {
    const scripts = { ...(manifest.scripts as Record<string, unknown>), prepublishOnly: value };
    expect(auditCliReleaseManifest({ manifest: mutated({ scripts }) })).toEqual([
      expect.stringContaining("scripts.prepublishOnly must be exactly"),
    ]);
  });

  it("refuses a dropped prepublishOnly guard", () => {
    const scripts = { ...(manifest.scripts as Record<string, string>) };
    delete scripts.prepublishOnly;
    expect(auditCliReleaseManifest({ manifest: mutated({ scripts }) })).toEqual([
      expect.stringContaining("prepublishOnly"),
    ]);
  });

  it("refuses an empty description, which is the package's npm listing", () => {
    expect(auditCliReleaseManifest({ manifest: mutated({ description: "  " }) })).toEqual([
      expect.stringContaining("description"),
    ]);
  });

  it.each([
    ["an empty object", {}],
    // "declares a support range" was satisfied by `*`, which claims the CLI runs on Node 18 —
    // where its own build toolchain does not.
    ['the wildcard "*"', { node: "*" }],
    ['">=18"', { node: ">=18" }],
    ['"^22"', { node: "^22" }],
    ['"^22.18.0"', { node: "^22.18.0" }],
    ["null", { node: null }],
  ])("refuses an engines field of %s", (_label, engines) => {
    expect(auditCliReleaseManifest({ manifest: mutated({ engines }) })).toEqual([
      expect.stringContaining("engines.node must be exactly"),
    ]);
  });

  it("refuses a tag that names a different version", () => {
    expect(auditCliReleaseManifest({ manifest, tag: "v9.9.9" })).toEqual([
      expect.stringContaining("does not match the manifest version"),
    ]);
  });

  it("refuses a bootstrap version in the manifest itself", () => {
    expect(
      auditCliReleaseManifest({ manifest: mutated({ version: "0.0.0-bootstrap.0" }) }),
    ).toEqual([expect.stringContaining("bootstrap placeholder")]);
  });

  it("reports every failure at once rather than the first", () => {
    const failures = auditCliReleaseManifest({
      manifest: mutated({ private: true, bin: {}, license: "MIT" }),
    });
    expect(failures.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a manifest that did not parse to an object", () => {
    expect(auditCliReleaseManifest({ manifest: null })).toEqual([
      "apps/cli/package.json did not parse to an object",
    ]);
  });
});
