#!/usr/bin/env node
/**
 * Read back the Release this run just wrote, and prove it is the bundle the run audited.
 *
 * The publish workflows uploaded assets and stopped. "The bytes were handed to GitHub" is strictly
 * weaker than "these bytes are what GitHub serves", and the registry half of the same path already
 * makes that distinction — it re-reads the published digest rather than trusting the upload.
 *
 * Assets are re-downloaded and hashed rather than compared against an API metadata field, for the
 * same reason: a consumer downloads bytes, so bytes are what has to match.
 *
 * Usage:
 *   verify-published-release.mjs --tag <tag> --checksum <release-sha256.txt> --asset <path>...
 *
 * Node built-ins plus `gh`, which the publish job already has. No dependency tree is guaranteed
 * here — this runs in the privileged job.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "./release-subprocess.mjs";
import {
  auditPublishedRelease,
  auditReleaseTargetEnvironment,
  parseChecksumFile,
  RELEASE_REPOSITORY,
} from "./release-target-contract.mjs";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function allArgs(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) {
      values.push(String(process.argv[index + 1]));
    }
  }
  return values;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  // First, and before any network call: an inherited `GH_REPO` would have sent every `gh` command
  // in this job — including the write that already happened — at a different repository.
  const environmentFailures = auditReleaseTargetEnvironment(process.env);
  if (environmentFailures.length > 0) {
    for (const failure of environmentFailures) console.error(`✗ ${failure}`);
    return 1;
  }

  const tag = arg("tag");
  const checksumPath = arg("checksum");
  if (!tag || !checksumPath) {
    console.error("Usage: verify-published-release.mjs --tag <tag> --checksum <file> --asset <p>…");
    return 2;
  }

  // The bundle's own checksum file covers the artifact. The checksum file ships beside it as an
  // asset too, so its digest is computed here rather than being listed inside itself.
  const expectedAssets = parseChecksumFile(readFileSync(checksumPath, "utf8"));
  for (const assetPath of [...allArgs("asset"), checksumPath]) {
    expectedAssets.set(basename(assetPath), sha256(resolve(assetPath)));
  }

  const work = mkdtempSync(join(tmpdir(), "fairux-release-verify-"));
  try {
    const raw = runSync("gh", [
      "release",
      "view",
      tag,
      "--repo",
      RELEASE_REPOSITORY,
      "--json",
      "tagName,isDraft,assets",
    ]);
    const release = JSON.parse(raw);

    // `--clobber` so a rerun overwrites its own previous download rather than failing; the files
    // are in a directory this process created and nothing else writes to.
    runSync("gh", [
      "release",
      "download",
      tag,
      "--repo",
      RELEASE_REPOSITORY,
      "--dir",
      work,
      "--clobber",
    ]);
    const downloadedAssets = new Map(
      readdirSync(work).map((name) => [name, sha256(join(work, name))]),
    );

    const failures = auditPublishedRelease({
      release,
      expectedAssets,
      downloadedAssets,
      expectedTag: tag,
    });
    if (failures.length > 0) {
      for (const failure of failures) console.error(`✗ ${failure}`);
      return 1;
    }

    for (const [name, digest] of expectedAssets) {
      console.log(`✓ ${name} on the published Release matches the audited bundle (${digest})`);
    }
    console.log(
      `✓ ${tag} is published, not a draft, and carries exactly ${expectedAssets.size} asset(s)`,
    );
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
