import { describe, expect, it } from "vitest";
import { getNpmRegistryState } from "../../apps/cli/scripts/npm-registry-state.mjs";
import {
  installedVersionMismatch,
  registrySmokeInstallArgs,
  unsmokableRegistryState,
} from "../../apps/cli/scripts/registry-smoke-test.mjs";
import {
  NPM_CLI_INSTALL_REGISTRY_ARGS,
  NPM_SDK_INSTALL_REGISTRY_ARGS,
} from "../../scripts/public-npm-registry.mjs";

/**
 * The registry-installed CLI smoke's own properties — the ones a green run cannot demonstrate.
 *
 * A run that installed from the wrong host, or that quietly exercised a different version than the
 * one it names, would be exactly as green as a correct one. Those are settled here instead, with no
 * network call: every read is injected.
 *
 * What is *not* here, deliberately: that the CLI behaves once installed. That is
 * `installed-cli-smoke-contract.mjs`, shared with the packed smoke, and it is checked by running
 * it — on Linux and Windows, on both Node.js floors.
 */

const SPEC = "fairux@0.1.0-beta.1";

describe("the registry-installed CLI smoke installs from the registry it names", () => {
  it("pins the public registry and asks for a fresh copy", () => {
    expect(registrySmokeInstallArgs(SPEC)).toEqual([
      "install",
      SPEC,
      "--no-audit",
      "--no-fund",
      // Without this, a `registry=` line in any project, user, or global `.npmrc` decides where the
      // smoke installs from — and a smoke that installs from somewhere other than where the release
      // was published proves nothing about the release.
      "--registry=https://registry.npmjs.org/",
      // A cached tarball is not evidence about what the registry currently serves, which is the
      // whole question this run is asking.
      "--prefer-online",
    ]);
  });

  it("pins no scope key, because fairux is unscoped", () => {
    // The SDK's install must pin `@fairux:registry` as well: npm resolves a scoped package through
    // it before falling back to `registry`. `fairux` has no scope key for npm to look up, so a pin
    // here would suggest a resolution path this package does not have.
    expect(NPM_CLI_INSTALL_REGISTRY_ARGS.join(" ")).not.toContain("@fairux:registry");
    expect(NPM_SDK_INSTALL_REGISTRY_ARGS.join(" ")).toContain("@fairux:registry");
  });

  it("reads the registry with the CLI's own arguments, not the SDK's", () => {
    const calls: string[][] = [];
    getNpmRegistryState(SPEC, {
      run: (_cmd, args) => {
        calls.push(args);
        return JSON.stringify({
          version: "0.1.0-beta.1",
          "dist.shasum": "a".repeat(40),
          "dist.integrity": `sha512-${"b".repeat(86)}==`,
        });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--registry=https://registry.npmjs.org/");
    expect(calls[0]).toContain("--prefer-online");
    expect(calls[0]?.join(" ")).not.toContain("@fairux:registry");
  });
});

describe("a registry state the smoke refuses to run against", () => {
  it("names an unpublished CLI as unpublished, not as a broken smoke", () => {
    // This is the repository's actual state until the first beta ships, so it is the message a
    // reader of a red canary sees most often. `npm install`'s own 404 reads as a broken harness.
    const reason = unsmokableRegistryState(SPEC, { status: "absent" });
    expect(reason).toContain("has not been published");
    expect(reason).toContain(SPEC);
  });

  it("keeps an unreadable registry distinct from an absent package", () => {
    const reason = unsmokableRegistryState(SPEC, {
      status: "unavailable",
      reason: "npm view returned malformed JSON",
    });
    expect(reason).toContain("could not be read");
    expect(reason).not.toContain("has not been published");
  });

  it("proceeds only when the registry serves the exact version", () => {
    expect(
      unsmokableRegistryState(SPEC, {
        status: "present",
        version: "0.1.0-beta.1",
        shasum: "a".repeat(40),
        integrity: `sha512-${"b".repeat(86)}==`,
      }),
    ).toBeNull();
  });
});

describe("the version the run is evidence about", () => {
  it("accepts the installed version when it is the resolved one", () => {
    expect(
      installedVersionMismatch({ installed: "0.1.0-beta.1", expected: "0.1.0-beta.1" }),
    ).toBeNull();
  });

  it("refuses a version the dist-tag moved to between resolving and installing", () => {
    // The one way a green canary can lie: it names the version it resolved while having exercised
    // whatever the tag pointed at a moment later.
    const reason = installedVersionMismatch({
      installed: "0.1.0-beta.2",
      expected: "0.1.0-beta.1",
    });
    expect(reason).toContain("0.1.0-beta.2");
    expect(reason).toContain("0.1.0-beta.1");
  });

  it("refuses a manifest with no version at all", () => {
    expect(installedVersionMismatch({ installed: undefined, expected: "0.1.0-beta.1" })).toContain(
      "expected 0.1.0-beta.1",
    );
  });
});

describe("one behaviour contract, not two", () => {
  it("reaches the installed CLI through the shared contract module", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(import.meta.dirname, "../../apps/cli/scripts/registry-smoke-test.mjs"),
      "utf8",
    );
    // A registry-only variant of these expectations would drift from the packed smoke's, and the
    // drift would be invisible: each path would keep passing its own copy.
    expect(source).toContain("./installed-cli-smoke-contract.mjs");
    expect(source).toContain("runInstalledCliSmoke");
    // Never `node dist/index.js`: a published `bin` npm never linked would still run under `node`
    // while `npx fairux` was broken. Matched on what is spawned, not on prose — a substring test
    // that a comment can satisfy is not a check.
    expect(source).toContain("installedCliBinPath");
    expect(source).toContain("runCommand(bin, args");
    expect(source).not.toMatch(/run(?:Command)?\(\s*"node"/);
    // Nothing local may reach the temp project — that is the packed smoke's job, not this one's.
    expect(source).not.toMatch(/run(?:Command)?\(\s*"pnpm"/);
    expect(source).not.toMatch(/["'][^"']*workspace:/);
  });
});
