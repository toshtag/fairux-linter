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
import { NPM_SDK_INSTALL_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
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

  const work = mkdtempSync(join(tmpdir(), "fairux-sdk-registry-smoke-"));
  let failed = false;
  try {
    const env = { npm_config_cache: join(work, ".npm-cache") };
    runSync("npm", ["init", "-y"], { cwd: work, env });
    runSync("npm", registrySmokeInstallArgs(spec), { cwd: work, env });
    runConsumerSmoke({ work, expectedVersion });
  } catch (error) {
    failed = true;
    console.error(error.message);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  process.exitCode = failed ? 1 : 0;
}
