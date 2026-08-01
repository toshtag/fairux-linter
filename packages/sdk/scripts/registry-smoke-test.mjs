#!/usr/bin/env node
/**
 * Install the published SDK from the public registry and run the consumer smoke against it.
 *
 * The install arguments are exported so a unit test can pin them without a network call. This was
 * the last release command still resolving its registry through npm config: `@fairux/sdk` is
 * scoped, npm consults `@fairux:registry` before `registry`, and a line in anyone's `.npmrc` would
 * have had this smoke installing from a different host than the one just published to — which
 * proves nothing about the release.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditInstalledSignatures,
  SIGNATURE_AUDIT_NPM_VERSION,
} from "../../../scripts/npm-signature-audit.mjs";
import {
  NPM_SDK_INSTALL_REGISTRY_ARGS,
  PUBLIC_NPM_REGISTRY,
} from "../../../scripts/public-npm-registry.mjs";
import { runConsumerSmoke, validateRegistryConsumerContract } from "./consumer-smoke.mjs";
import { SDK_PACKAGE_NAME } from "./release-notes.mjs";
import { runSync } from "./sdk-release-utils.mjs";

/**
 * The exact `npm install` arguments this smoke uses.
 *
 * @param {string} spec  `@fairux/sdk@<version>`
 * @returns {string[]}
 */
export function registrySmokeInstallArgs(spec) {
  return ["install", spec, "--no-audit", "--no-fund", ...NPM_SDK_INSTALL_REGISTRY_ARGS];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spec = process.env.SDK_SPEC;
  const expectedVersion = process.env.EXPECTED_VERSION;
  if (!spec || !expectedVersion) {
    console.error(
      "Usage: SDK_SPEC=@fairux/sdk@<version> EXPECTED_VERSION=<version> pnpm registry:smoke:sdk",
    );
    process.exit(2);
  }

  // The evidence a registry canary run must be readable from its log alone: which registry was
  // asked, for what, expecting what, asserting which versioned contract at which digest, on
  // which runtime. The contract identity comes from the validated manifest, not from a guess —
  // so the log cannot claim a contract the fixture on disk does not satisfy.
  const contract = validateRegistryConsumerContract();
  console.log(`registry=${PUBLIC_NPM_REGISTRY}`);
  console.log(`spec=${spec}`);
  console.log(`expectedVersion=${expectedVersion}`);
  console.log("profile=registry-consumer");
  console.log(`contract=${contract.id}`);
  console.log(`contractMinimumSdkVersion=${contract.minimumSdkVersion}`);
  console.log(`contractSha256=${contract.contentSha256}`);
  console.log(`node=${process.version}`);
  console.log(`signatureAuditNpm=${SIGNATURE_AUDIT_NPM_VERSION}`);

  const work = mkdtempSync(join(tmpdir(), "fairux-sdk-registry-smoke-"));
  let failed = false;
  try {
    const env = { npm_config_cache: join(work, ".npm-cache") };
    runSync("npm", ["init", "-y"], { cwd: work, env });
    runSync("npm", registrySmokeInstallArgs(spec), { cwd: work, env });

    // The signature and provenance audit the Release notes and the runbook both delegate to "the
    // registry-installed smoke". They said so before this existed, which made the sentence a plan
    // rather than a description — the CLI's smoke had the check and the SDK's did not.
    //
    // Against the installed tree, by a pinned npm, before the consumer smoke: a package whose
    // signature does not verify is not one whose behaviour is worth measuring.
    const signatureFailures = auditInstalledSignatures({
      run: (cmd, args) => runSync(cmd, args, { cwd: work, env }),
      registryArgs: NPM_SDK_INSTALL_REGISTRY_ARGS,
      packageName: SDK_PACKAGE_NAME,
      expectedVersion,
      registry: PUBLIC_NPM_REGISTRY,
    });
    if (signatureFailures.length > 0) {
      // Raised, not collected: `runConsumerSmoke` below reports its own failures, and a signature
      // failure that only added a line to that report would let the run's exit status be decided by
      // something else entirely.
      throw new Error(`npm audit signatures failed:\n  - ${signatureFailures.join("\n  - ")}`);
    }
    console.log(
      `✓ npm audit signatures verified ${spec} with SLSA provenance against ${PUBLIC_NPM_REGISTRY}`,
    );
    // The registry-consumer profile, explicitly: this smoke observes a published SDK, which may
    // legitimately predate this checkout's generated catalog. The exact-catalog claim belongs to
    // the pack/tarball callers, which smoke an artifact packed from this checkout.
    runConsumerSmoke({ work, expectedVersion, profile: "registry-consumer" });
  } catch (error) {
    failed = true;
    console.error(error.message);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  process.exitCode = failed ? 1 : 0;
}
