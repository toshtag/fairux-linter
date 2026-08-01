#!/usr/bin/env node
/**
 * Refuse an environment that could redirect a release write, before one happens.
 *
 * `gh` resolves its target from the environment: `GH_REPO` wins over the checkout's remote, and
 * `GH_HOST` points at a different GitHub entirely. An inherited value — from a composite action, a
 * reusable workflow, an organisation variable — would send `gh release create` at another
 * repository while every other check in the run passed and nothing looked wrong.
 *
 * A separate entry point from the post-write verifier so it can run *before* the write, which is
 * the only position from which it prevents anything.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditReleaseTargetEnvironment, RELEASE_REPOSITORY } from "./release-target-contract.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = auditReleaseTargetEnvironment(process.env);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ release writes can only reach ${RELEASE_REPOSITORY}`);
  }
}
