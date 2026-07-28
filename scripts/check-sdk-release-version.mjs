#!/usr/bin/env node
/**
 * Refuse an SDK release version the workflow is not allowed to publish, in the `validate` job.
 *
 * Four checks called themselves beta-only while testing something weaker — a `prerelease` boolean
 * here, in the bundle assembler, and in the bundle verifier, and a bare `version.includes("-")` in
 * the release check. `0.1.0-alpha.1`, `0.1.0-rc.1`, and the purely numeric `0.1.0-1` satisfied all
 * four ([issue #68](https://github.com/toshtag/fairux-linter/issues/68)).
 *
 * A file rather than a `node -e` string in the YAML, for two reasons. A test can run it and read
 * its exit status, which an assertion that the workflow *mentions* a helper cannot: an inline
 * script that called the helper and ignored the answer would have satisfied that. And it runs in
 * `validate`, before any job installs a dependency, packs a tarball, or holds an OIDC token — the
 * earliest point at which the version is knowable, since the workflow is tag-triggered.
 *
 * Node built-ins only; `validate` installs nothing.
 */
import { classifyVersion, isBetaPrerelease } from "./release-version-contract.mjs";

const version = process.argv[2];

if (version === undefined) {
  console.error("Usage: check-sdk-release-version.mjs <version>");
  process.exit(2);
}

if (!classifyVersion(version).valid) {
  console.error(`ERROR: SDK tag version is not valid SemVer: ${version}`);
  process.exit(1);
}

if (!isBetaPrerelease(version)) {
  console.error(
    `ERROR: P20 SDK workflow requires a beta prerelease version: ${version}\n` +
      "  The release path, its notes, and the `next` dist-tag all describe a beta.",
  );
  process.exit(1);
}

console.log(`✓ ${version} is a beta prerelease version`);
