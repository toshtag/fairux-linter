#!/usr/bin/env node
/**
 * The publish workflow's earliest gate: is this tag a `fairux` release, and where does it publish?
 *
 * Runs in `validate`, before any job installs a dependency or runs a repository script from the
 * tagged commit. It reads only the checked-out manifest — no registry, no network — so the answer
 * is a property of the commit being released.
 *
 * Node built-ins only, so the privileged publish job can run it too.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditCliReleaseManifest,
  CliReleaseError,
  resolveCliRelease,
} from "./cli-release-contract.mjs";

const USAGE = "Usage: check-cli-release-version.mjs <tag> [--github-env <path>]";

function main(argv) {
  const tag = argv.find((argument) => !argument.startsWith("--"));
  if (!tag) {
    console.error(USAGE);
    process.exit(2);
  }

  const release = resolveCliRelease(tag);

  const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const failures = auditCliReleaseManifest({ manifest, tag });
  if (failures.length > 0) {
    console.error(`\n✖ apps/cli/package.json does not describe ${tag}:\n`);
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
  console.error(error instanceof CliReleaseError ? `ERROR: ${error.message}` : error.message);
  process.exit(1);
}
