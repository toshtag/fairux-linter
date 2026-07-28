#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Importing the generator runs nothing: its CLI sits behind a main guard.
import { sdkReleaseNotesInvocation } from "./release-notes.mjs";
import { computeTarballDigests, runSync } from "./sdk-release-utils.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sdkDir, "..", "..");
const tag = arg("--tag") ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error("Usage: release-dry-run.mjs --tag sdk-v<version>");
  process.exit(2);
}

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
  runSync("npm", ["publish", "--dry-run", "--json", "--ignore-scripts", "--tag", "next", tarball], {
    cwd: work,
    env: { npm_config_cache: join(work, ".npm-cache") },
  });
  console.log("✓ SDK release dry-run passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
