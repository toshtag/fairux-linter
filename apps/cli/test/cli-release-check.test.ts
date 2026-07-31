import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditCliReleaseManifest, CLI_PUBLISHED_FILES } from "../scripts/cli-release-contract.mjs";

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
  it("refuses a private package", () => {
    expect(auditCliReleaseManifest({ manifest: mutated({ private: true }) })).toContain(
      "package is private and cannot be published",
    );
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

  it("refuses a workspace specifier in a published dependency map", () => {
    expect(
      auditCliReleaseManifest({
        manifest: mutated({ dependencies: { "@fairux/core": "workspace:*" } }),
      }),
    ).toContain(
      "dependencies.@fairux/core is a workspace specifier and would not resolve for a consumer",
    );
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

  it("refuses a manifest with no engines range", () => {
    expect(auditCliReleaseManifest({ manifest: mutated({ engines: {} }) })).toEqual([
      expect.stringContaining("engines.node"),
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
