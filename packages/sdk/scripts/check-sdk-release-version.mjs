#!/usr/bin/env node
/**
 * The publish workflow's earliest gate: is this tag an `@fairux/sdk` release, and where does it
 * publish?
 *
 * Runs in `validate`, before any job installs a dependency, packs a tarball, or holds an OIDC
 * token — the earliest point at which the version is knowable, since the workflow is tag-triggered.
 * It reads only the checked-out manifest — no registry, no network — so the answer is a property of
 * the commit being released.
 *
 * A file rather than a `node -e` string in the YAML, because a test can run it and read its exit
 * status; an assertion that the workflow *mentions* a helper would pass for an inline script that
 * called it and ignored the answer.
 *
 * It used to refuse anything that was not a beta, and it used to live at
 * `scripts/check-sdk-release-version.mjs` because there was no SDK release contract for it to sit
 * beside. Both changed together: the policy it enforces is now
 * `packages/sdk/scripts/sdk-release-contract.mjs`, which routes a prerelease of any kind to `next`
 * and a stable version to `latest`, and refuses the bootstrap placeholder. What that widening does
 * and does not permit is written out there rather than inferred from this file's absence of a
 * check.
 *
 * Node built-ins only; `validate` installs nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSdkRelease, SDK_PACKAGE_NAME, SdkReleaseError } from "./sdk-release-contract.mjs";

const USAGE = "Usage: check-sdk-release-version.mjs <tag>";

function main(argv) {
  const tag = argv.find((argument) => !argument.startsWith("--"));
  if (!tag) {
    console.error(USAGE);
    process.exit(2);
  }

  const release = resolveSdkRelease(tag);

  const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // The three manifest facts a release of *this* package rests on, asserted before any dependency
  // is installed. They used to be shell comparisons in the workflow, which is where the CLI's half
  // of this boundary started too.
  const failures = [];
  if (manifest.name !== SDK_PACKAGE_NAME) {
    failures.push(`name must be "${SDK_PACKAGE_NAME}", got ${JSON.stringify(manifest.name)}`);
  }
  if (manifest.private !== false) {
    failures.push(`private must be the boolean false, got ${JSON.stringify(manifest.private)}`);
  }
  if (manifest.version !== release.version) {
    failures.push(`tag ${tag} does not match the manifest version ${manifest.version}`);
  }

  if (failures.length > 0) {
    console.error(`\n✖ packages/sdk/package.json does not describe ${tag}:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`✓ ${tag} releases ${manifest.name} ${release.version}`);
  console.log(`  dist-tag: ${release.distTag}  (derived from the checked-out manifest)`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  // A refused tag and a broken script exit the same way here on purpose: neither may publish. The
  // message distinguishes them for a human reading the run.
  console.error(error instanceof SdkReleaseError ? `ERROR: ${error.message}` : error.message);
  process.exit(1);
}
