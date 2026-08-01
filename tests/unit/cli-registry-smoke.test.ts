import { describe, expect, it } from "vitest";
import { getNpmRegistryState } from "../../apps/cli/scripts/npm-registry-state.mjs";
import {
  installedVersionMismatch,
  registrySmokeInstallArgs,
  signatureAuditFailures,
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

describe("the signature and provenance audit of the installed tree", () => {
  /**
   * The fixture is the shape `npm audit signatures --json --include-attestations` actually returned
   * for `@fairux/sdk@0.1.0-beta.2` — the published package this repository can observe — with the
   * name changed. Inventing the shape would have made every assertion below about a response npm
   * does not produce.
   */
  const audit = (overrides: Record<string, unknown> = {}) => ({
    invalid: [],
    missing: [],
    verified: [
      {
        name: "fairux",
        version: "0.1.0-beta.1",
        location: "node_modules/fairux",
        registry: "https://registry.npmjs.org/",
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/fairux@0.1.0-beta.1",
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      },
    ],
    ...overrides,
  });

  const check = (report: unknown) =>
    signatureAuditFailures({
      report,
      packageName: "fairux",
      expectedVersion: "0.1.0-beta.1",
      registry: "https://registry.npmjs.org/",
    });

  it("accepts a verified package with SLSA provenance from the public registry", () => {
    expect(check(audit())).toEqual([]);
  });

  it("refuses a CLI with no attestation at all", () => {
    // The publish workflow reads back that npm *reports* attestation metadata — a claim about an
    // API response, made by the process that wrote it. This is the independent half.
    expect(check(audit({ verified: [] }))).toEqual([
      "fairux carries no verified attestation — the published CLI must have provenance",
    ]);
  });

  it("refuses an attestation that is not SLSA provenance", () => {
    const report = audit();
    report.verified[0].attestations.provenance = { predicateType: "https://example.invalid/v1" };
    expect(check(report).join(" ")).toContain("no SLSA provenance predicate");
  });

  it("refuses an attestation verified against a different registry", () => {
    const report = audit();
    report.verified[0].registry = "https://registry.example.invalid/";
    expect(check(report).join(" ")).toContain("verified against https://registry.example.invalid/");
  });

  it("refuses an attestation for a different version", () => {
    const report = audit();
    report.verified[0].version = "0.1.0-beta.2";
    expect(check(report).join(" ")).toContain("is 0.1.0-beta.2, expected 0.1.0-beta.1");
  });

  it("fails on an invalid signature anywhere in the tree", () => {
    // Not only on `fairux`: an invalid signature is a tampered artifact in the tree this CLI runs
    // from, whoever published it.
    const failures = check(audit({ invalid: [{ name: "parse5", version: "7.3.0" }] }));
    expect(failures.join(" ")).toContain("parse5@7.3.0");
  });

  it("tolerates dependencies that simply carry no attestation", () => {
    // `verified` lists packages with attestations, which most of the tree does not have. Failing on
    // that would be failing on other maintainers' publish choices, not on this release.
    expect(check(audit())).toEqual([]);
    expect(check(audit({ missing: [{ name: "some-dep", version: "1.0.0" }] }))).toEqual([]);
  });

  it("fails when fairux itself has no registry signature", () => {
    const failures = check(audit({ missing: [{ name: "fairux", version: "0.1.0-beta.1" }] }));
    expect(failures.join(" ")).toContain("fairux has no registry signature");
  });

  it("treats a malformed audit response as unverified rather than as a pass", () => {
    expect(check(undefined).length).toBeGreaterThan(0);
    expect(check({}).length).toBeGreaterThan(0);
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
