#!/usr/bin/env node
/**
 * Rehearse the SDK release path, without a tag and without a registry.
 *
 * Pack once, smoke the exact tarball, audit those bytes against the release contract, render the
 * notes through the invocation the workflow itself uses, and then `npm publish --dry-run` on the
 * channel this version actually publishes to — which used to be the literal `next`, so the
 * rehearsal proved nothing about the one command a stable release runs differently.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPublishDryRun } from "../../../scripts/npm-publish-dry-run.mjs";
// Importing the generator runs nothing: its CLI sits behind a main guard.
import { sdkReleaseNotesInvocation } from "./release-notes.mjs";
import { resolveSdkRelease, sdkReleaseTag, sdkTarballName } from "./sdk-release-contract.mjs";
import { computeTarballDigests, runSync } from "./sdk-release-utils.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sdkDir, "..", "..");
const manifest = JSON.parse(readFileSync(resolve(sdkDir, "package.json"), "utf8"));
// Default to the tag this checkout's version would be released under, so the usual invocation is
// `pnpm release:dry-run:sdk` with no arguments and the rehearsal still names a real release.
const tag = arg("--tag") ?? process.env.GITHUB_REF_NAME ?? sdkReleaseTag(manifest.version);

const release = resolveSdkRelease(tag);
console.log(`▶ rehearsing ${tag} → @fairux/sdk ${release.version} on ${release.distTag}`);

const work = mkdtempSync(join(tmpdir(), "fairux-sdk-release-dry-run-"));
try {
  runSync("pnpm", ["--filter", "@fairux/sdk", "pack", "--pack-destination", work], {
    cwd: repoRoot,
    env: { npm_config_cache: join(work, ".npm-cache") },
  });
  const tarballs = readdirSync(work).filter(
    (file) => file.startsWith("fairux-sdk-") && file.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one SDK tarball, got ${tarballs.length}`);
  }
  // Derived from the manifest, not read off the directory: a tarball for another version is not the
  // artifact this rehearsal is about.
  const expected = sdkTarballName(release.version);
  if (tarballs[0] !== expected) {
    throw new Error(`expected ${expected}, packed ${tarballs[0]}`);
  }
  const tarball = join(work, tarballs[0]);
  const digests = computeTarballDigests(tarball);

  runSync("pnpm", ["pack:smoke:sdk"], {
    cwd: repoRoot,
    env: {
      TARBALL: tarball,
      EXPECTED_SHA256: digests.sha256,
      npm_config_cache: join(work, ".npm-cache"),
    },
  });
  runSync("pnpm", ["release:check:sdk", "--", "--tag", tag], {
    cwd: repoRoot,
    env: { TARBALL: tarball },
  });
  // The generator derives this argv, so the dry run cannot drift away from the invocation it is
  // meant to rehearse. A generator that would refuse the release's own facts then fails here
  // rather than after `npm publish`. `HEAD` stands in for the tagged commit: the dry run rehearses
  // the path, and the generator only requires a full SHA.
  const commit = runSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  runSync("node", sdkReleaseNotesInvocation({ tag, sourceCommit: commit, tarball }), {
    cwd: repoRoot,
  });
  // The exact publish command's own acceptance of this tarball, minus the network — except that it
  // is not offline: npm resolves the package on the registry, so once this version is published the
  // command refuses it. That refusal is a fact about the registry's state and not about these
  // bytes; every other npm failure still stops the rehearsal.
  const { alreadyPublished } = runPublishDryRun({
    args: [
      "publish",
      "--dry-run",
      "--json",
      "--ignore-scripts",
      "--access",
      "public",
      "--tag",
      release.distTag,
      tarball,
    ],
    version: release.version,
    run: (args) =>
      runSync("npm", args, { cwd: work, env: { npm_config_cache: join(work, ".npm-cache") } }),
  });
  console.log(`\n✓ SDK release dry run passed for ${tag}`);
  if (alreadyPublished) {
    console.log(`  npm publish --dry-run: ${release.version} is already on the registry`);
  }
  console.log(`  tarball:  ${tarballs[0]}`);
  console.log(`  SHA-256:  ${digests.sha256}`);
  console.log(`  dist-tag: ${release.distTag}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
