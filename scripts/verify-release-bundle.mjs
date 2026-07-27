#!/usr/bin/env node
/**
 * Re-derive and verify a release bundle inside the privileged publish job.
 *
 * The bundle is produced by an unprivileged `prepare` job so that dependency and package lifecycle
 * scripts never run while an OIDC token can be minted. The trade is that the publish job receives
 * an artifact it did not build — so it re-computes the digests itself and checks them against the
 * metadata, rather than accepting the metadata's word.
 *
 * It also re-checks the identity the tag asserts: the metadata's tag, commit, and version must
 * match this run and the checked-out `packages/sdk/package.json`, and the tarball filename must
 * match the version. A bundle from a different tag or commit is refused.
 *
 * Node built-ins only, and no dependency install: this runs in the job that holds
 * `id-token: write`.
 *
 * Writes the verified values to `--github-env` and echoes shell assignments on stdout so the
 * caller can `eval` them.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const bundleDir = resolve(argument("bundle") ?? fail("--bundle is required"));
const tag = argument("tag") ?? fail("--tag is required");
const commit = argument("commit") ?? fail("--commit is required");
const packageJsonPath = resolve(argument("package-json") ?? fail("--package-json is required"));
const githubEnv = argument("github-env");

const metadata = JSON.parse(readFileSync(join(bundleDir, "release-metadata.json"), "utf8"));
const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const tarballs = readdirSync(bundleDir).filter((file) => file.endsWith(".tgz"));
if (tarballs.length !== 1)
  fail(`expected exactly one tarball in the bundle, got ${tarballs.length}`);
const tarballPath = join(bundleDir, tarballs[0]);

if (metadata.package !== manifest.name) {
  fail(`bundle is for ${metadata.package}, this commit builds ${manifest.name}`);
}
if (metadata.version !== manifest.version) {
  fail(
    `bundle version ${metadata.version} does not match packages/sdk/package.json ${manifest.version}`,
  );
}
if (metadata.tag !== tag) fail(`bundle was built for tag ${metadata.tag}, this run is ${tag}`);
if (metadata.commit !== commit) {
  fail(`bundle was built from commit ${metadata.commit}, this run is ${commit}`);
}
if (basename(tarballPath) !== metadata.tarball) {
  fail(`bundle contains ${basename(tarballPath)} but metadata names ${metadata.tarball}`);
}
if (!basename(tarballPath).includes(manifest.version)) {
  fail(`tarball ${basename(tarballPath)} does not carry version ${manifest.version}`);
}

// Recomputed here, in the privileged job, rather than trusted from the metadata.
const bytes = readFileSync(tarballPath);
const sha1 = createHash("sha1").update(bytes).digest("hex");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

for (const [label, actual, expected] of [
  ["SHA-1", sha1, metadata.sha1],
  ["SHA-256", sha256, metadata.sha256],
  ["integrity", integrity, metadata.integrity],
]) {
  if (actual !== expected) {
    fail(`${label} mismatch: bundle claims ${expected}, recomputed ${actual}`);
  }
}

const checksumFile = readFileSync(join(bundleDir, "fairux-sdk-sha256.txt"), "utf8");
if (!checksumFile.includes(sha256)) {
  fail("fairux-sdk-sha256.txt does not contain the recomputed SHA-256");
}

const resolved = {
  TARBALL: tarballPath,
  SDK_VERSION: manifest.version,
  SDK_SPEC: `${manifest.name}@${manifest.version}`,
  DIST_TAG: metadata.distTag,
  SHA1: sha1,
  SHA256: sha256,
  INTEGRITY: integrity,
};

if (githubEnv) {
  appendFileSync(
    githubEnv,
    `${Object.entries(resolved)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

console.error(`✓ release bundle verified for ${resolved.SDK_SPEC} (${tag} @ ${commit})`);
console.error(`  tarball: ${basename(tarballPath)}`);
console.error(`  SHA-256: ${sha256}`);

for (const [key, value] of Object.entries(resolved)) {
  process.stdout.write(`export ${key}='${value}'\n`);
}
