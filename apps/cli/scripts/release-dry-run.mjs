#!/usr/bin/env node
/**
 * Rehearse the CLI release path, without a tag and without a registry.
 *
 * Pack once, smoke the exact tarball, audit those bytes against the release contract, and render
 * the release notes through the invocation the workflow itself uses. Then `npm publish --dry-run`,
 * so the command the privileged job runs is known to accept this artifact.
 *
 * CI runs it on every push to `main` on both supported Node.js floors. The SDK has
 * `sdk-release-preflight` for exactly this; the CLI had no equivalent, so its release path was
 * first exercised end to end by a real tag — which is when a mistake costs a consumed tag rather
 * than a red check.
 *
 * The one thing it deliberately does not rehearse is the registry. A rehearsal that consulted npm
 * would answer differently before and after a publication — and the question it exists to answer is
 * about the artifact, not about what is published. The registry-facing contracts — the publication
 * plan, the channel audits, the provenance read-back — are exercised with injected readers in unit
 * tests instead, and the one below is run here against the metadata shape the public registry
 * actually returns, so the rehearsal fails if that contract stops accepting a real npm response.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPublishDryRun } from "../../../scripts/npm-publish-dry-run.mjs";
import { runSync } from "../../../scripts/release-subprocess.mjs";
import { classifyCliProvenance } from "./cli-provenance-contract.mjs";
import { cliReleaseTag, cliTarballName, resolveCliRelease } from "./cli-release-contract.mjs";
// Importing the generator runs nothing: its CLI sits behind a main guard.
import { cliReleaseNotesInvocation } from "./release-notes.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliDir, "..", "..");

const manifest = JSON.parse(readFileSync(resolve(cliDir, "package.json"), "utf8"));
// Default to the tag this checkout's version would be released under, so the usual invocation is
// `pnpm release:dry-run:cli` with no arguments and the rehearsal still names a real release.
const tag = arg("--tag") ?? process.env.GITHUB_REF_NAME ?? cliReleaseTag(manifest.version);

const release = resolveCliRelease(tag);
console.log(`▶ rehearsing ${tag} → fairux ${release.version} on ${release.distTag}`);

const work = mkdtempSync(join(tmpdir(), "fairux-cli-release-dry-run-"));
try {
  runSync("pnpm", ["--filter", "fairux", "pack", "--pack-destination", work], {
    cwd: repoRoot,
    env: { npm_config_cache: join(work, ".npm-cache") },
  });
  const tarballs = readdirSync(work).filter(
    (file) => file.startsWith("fairux-") && file.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one CLI tarball, got ${tarballs.length}`);
  }
  // Derived from the manifest, not read off the directory: a tarball for another version is not
  // the artifact this rehearsal is about.
  const expected = cliTarballName(release.version);
  if (tarballs[0] !== expected) {
    throw new Error(`expected ${expected}, packed ${tarballs[0]}`);
  }
  const tarball = join(work, tarballs[0]);
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");

  runSync("pnpm", ["pack:smoke"], {
    cwd: repoRoot,
    env: {
      TARBALL: tarball,
      EXPECTED_SHA256: sha256,
      npm_config_cache: join(work, ".npm-cache"),
    },
  });

  runSync("pnpm", ["release:check:cli", "--", "--tag", tag, "--tarball", tarball], {
    cwd: repoRoot,
  });

  // The generator derives this argv, so the dry run cannot drift away from the invocation it is
  // meant to rehearse — the drift that stopped the SDK's dry run from covering its publish job.
  // `HEAD` stands in for the tagged commit: the rehearsal exercises the path, and the generator
  // only requires a full SHA.
  const commit = runSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim();
  runSync("node", cliReleaseNotesInvocation({ tag, sourceCommit: commit, tarball }), {
    cwd: repoRoot,
  });

  // The provenance contract, against the shape `npm view … dist.attestations --json` returns for
  // a package published this way. No registry read: `fairux` has none yet, and the point here is
  // that the contract the publish job will run still accepts a real response.
  const provenance = classifyCliProvenance({
    attestations: {
      url: `https://registry.npmjs.org/-/npm/v1/attestations/fairux@${release.version}`,
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  });
  if (provenance.state !== "present") {
    throw new Error(`provenance contract rejects a real npm response: ${provenance.failures}`);
  }

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

  console.log(`\n✓ CLI release dry run passed for ${tag}`);
  if (alreadyPublished) {
    console.log(`  npm publish --dry-run: ${release.version} is already on the registry`);
  }
  console.log(`  tarball: ${tarballs[0]}`);
  console.log(`  SHA-256: ${sha256}`);
  console.log(`  dist-tag: ${release.distTag}`);
  console.log("  provenance contract accepts a real npm attestation response");
} catch (error) {
  console.error(`\n✖ CLI release dry run failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
