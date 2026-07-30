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
  NPM_SDK_INSTALL_REGISTRY_ARGS,
  PUBLIC_NPM_REGISTRY,
} from "../../../scripts/public-npm-registry.mjs";
import { runConsumerSmoke } from "./consumer-smoke.mjs";
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
  // asked, for what, expecting what, asserting which contract, on which runtime.
  console.log(`registry=${PUBLIC_NPM_REGISTRY}`);
  console.log(`spec=${spec}`);
  console.log(`expectedVersion=${expectedVersion}`);
  console.log("profile=registry-consumer");
  console.log(`node=${process.version}`);

  const work = mkdtempSync(join(tmpdir(), "fairux-sdk-registry-smoke-"));
  let failed = false;
  try {
    const env = { npm_config_cache: join(work, ".npm-cache") };
    runSync("npm", ["init", "-y"], { cwd: work, env });
    runSync("npm", registrySmokeInstallArgs(spec), { cwd: work, env });
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
