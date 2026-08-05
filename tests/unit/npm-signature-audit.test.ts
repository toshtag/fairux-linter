import { describe, expect, it } from "vitest";
import {
  auditInstalledSignatures,
  SIGNATURE_AUDIT_NPM_VERSION,
  SLSA_PROVENANCE_PREDICATE,
  signatureAuditArgs,
  signatureAuditFailures,
} from "../../scripts/npm-signature-audit.mjs";
import {
  NPM_CLI_INSTALL_REGISTRY_ARGS,
  NPM_SDK_INSTALL_REGISTRY_ARGS,
  PUBLIC_NPM_REGISTRY,
} from "../../scripts/public-npm-registry.mjs";

/**
 * The registry signature audit, shared by the CLI and SDK registry smokes.
 *
 * The publish workflow reads back that npm *reports* attestation metadata — a claim about an API
 * response, made by the process that wrote it. This is the independent half: a clean install audited
 * against the registry's own keys by a process that published nothing.
 *
 * None of it is observable from a green run — an audit that silently did nothing would be exactly as
 * green as one that verified everything — so it is settled here, with no network call.
 */

const REGISTRY = PUBLIC_NPM_REGISTRY;

/**
 * The shape `npm audit signatures --json --include-attestations` **actually returned** for
 * `@fairux/sdk@0.1.0-beta.2`, the published package this repository can observe. Inventing the shape
 * would have made every assertion below about a response npm does not produce — and the
 * `--include-attestations` flag exists in the argv precisely because without it there is no
 * `verified` array at all.
 */
const auditReport = (packageName: string, overrides: Record<string, unknown> = {}) => ({
  invalid: [],
  missing: [],
  verified: [
    {
      name: packageName,
      version: "0.1.0-beta.3",
      location: `node_modules/${packageName}`,
      registry: REGISTRY,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/${packageName}@0.1.0-beta.3`,
        provenance: { predicateType: SLSA_PROVENANCE_PREDICATE },
      },
    },
  ],
  ...overrides,
});

/**
 * The single verified entry `auditReport` builds, for the cases that corrupt one field of it.
 *
 * `report.verified[0]` is `| undefined` under `noUncheckedIndexedAccess`, and the fixture above is
 * where that entry is guaranteed — so the guarantee is stated once here rather than asserted away
 * at each of the three sites that mutate it.
 */
function firstVerified(report: ReturnType<typeof auditReport>) {
  const entry = report.verified[0];
  if (!entry) throw new Error("auditReport should build one verified entry");
  return entry;
}

const check = (packageName: string, report: unknown) =>
  signatureAuditFailures({
    report,
    packageName,
    expectedVersion: "0.1.0-beta.3",
    registry: REGISTRY,
  });

describe("the audit's own invocation", () => {
  it("pins the verifier npm rather than using the runner's", () => {
    // The audit's meaning depends on which npm performs it: an older one predates keyless
    // attestation verification, and a floating `latest` would change what a green run means without
    // anything in this repository changing.
    const args = signatureAuditArgs(NPM_SDK_INSTALL_REGISTRY_ARGS);
    expect(args).toContain(`--package=npm@${SIGNATURE_AUDIT_NPM_VERSION}`);
    expect(SIGNATURE_AUDIT_NPM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(args).not.toContain("--package=npm@latest");
  });

  it("always asks for attestations", () => {
    // Without it the response carries only `invalid` and `missing`, and "no invalid signatures" is a
    // strictly weaker claim than "this package has verifiable provenance".
    for (const registryArgs of [NPM_SDK_INSTALL_REGISTRY_ARGS, NPM_CLI_INSTALL_REGISTRY_ARGS]) {
      expect(signatureAuditArgs(registryArgs)).toContain("--include-attestations");
      expect(signatureAuditArgs(registryArgs)).toContain("--json");
    }
  });

  it("carries the package's own registry pinning", () => {
    // The scoped SDK needs both keys; the unscoped CLI needs one. Auditing against a host other than
    // the one published to would prove nothing about the release.
    expect(signatureAuditArgs(NPM_SDK_INSTALL_REGISTRY_ARGS).join(" ")).toContain(
      "@fairux:registry=",
    );
    expect(signatureAuditArgs(NPM_CLI_INSTALL_REGISTRY_ARGS).join(" ")).toContain("--registry=");
  });
});

describe.each([["fairux"], ["@fairux/sdk"]])("what the audit accepts for %s", (packageName) => {
  it("accepts a verified package with SLSA provenance from the public registry", () => {
    expect(check(packageName, auditReport(packageName))).toEqual([]);
  });

  it("refuses a package with no attestation at all", () => {
    expect(check(packageName, auditReport(packageName, { verified: [] })).join(" ")).toContain(
      "carries no verified attestation",
    );
  });

  it("refuses an attestation that is not SLSA provenance", () => {
    const report = auditReport(packageName);
    firstVerified(report).attestations.provenance = { predicateType: "https://example.invalid/v1" };
    expect(check(packageName, report).join(" ")).toContain("carries no");
  });

  it("refuses an attestation verified against a different registry", () => {
    const report = auditReport(packageName);
    firstVerified(report).registry = "https://registry.example.invalid/";
    expect(check(packageName, report).join(" ")).toContain("verified against");
  });

  it("refuses an attestation for a different version", () => {
    const report = auditReport(packageName);
    firstVerified(report).version = "0.1.0-beta.2";
    expect(check(packageName, report).join(" ")).toContain(
      "is 0.1.0-beta.2, expected 0.1.0-beta.3",
    );
  });

  it("fails on an invalid signature anywhere in the tree", () => {
    // Not only on this package: an invalid signature is a tampered artifact in the tree it runs
    // from, whoever published it.
    expect(
      check(
        packageName,
        auditReport(packageName, { invalid: [{ name: "parse5", version: "7.3.0" }] }),
      ).join(" "),
    ).toContain("parse5@7.3.0");
  });

  it("tolerates dependencies that carry no attestation", () => {
    // `verified` lists packages with attestations, which most of a tree does not have. Failing there
    // would be failing on other maintainers' publish choices.
    expect(
      check(
        packageName,
        auditReport(packageName, { missing: [{ name: "dep", version: "1.0.0" }] }),
      ),
    ).toEqual([]);
  });

  it("fails when this package itself has no registry signature", () => {
    expect(
      check(
        packageName,
        auditReport(packageName, { missing: [{ name: packageName, version: "x" }] }),
      ).join(" "),
    ).toContain("has no registry signature");
  });

  it("treats a malformed report as unverified rather than as a pass", () => {
    expect(check(packageName, undefined).length).toBeGreaterThan(0);
    expect(check(packageName, {}).length).toBeGreaterThan(0);
  });
});

/**
 * The one thing this must never do is let a broken audit read as a clean one. Each of these is a way
 * the audit produces no failures list at all, and each has to become a failure rather than silence.
 */
describe("a broken audit is never a clean audit", () => {
  const run = (result: () => string) => (_cmd: string, _args: string[]) => result();
  const audit = (runner: (cmd: string, args: string[]) => string) =>
    auditInstalledSignatures({
      run: runner,
      registryArgs: NPM_SDK_INSTALL_REGISTRY_ARGS,
      packageName: "@fairux/sdk",
      expectedVersion: "0.1.0-beta.3",
      registry: REGISTRY,
    });

  it("reports a subprocess that could not run", () => {
    expect(
      audit(
        run(() => {
          throw new Error("npm not found");
        }),
      ).join(" "),
    ).toContain("failed to run");
  });

  it("reports output that is not JSON", () => {
    expect(audit(run(() => "npm ERR! something")).join(" ")).toContain("unparseable JSON");
  });

  it("reports JSON that is not an object", () => {
    expect(audit(run(() => "[]")).join(" ")).toContain("an array");
    expect(audit(run(() => '"ok"')).join(" ")).toContain("string");
  });

  it("passes only on a real, complete report", () => {
    expect(audit(run(() => JSON.stringify(auditReport("@fairux/sdk"))))).toEqual([]);
  });
});
