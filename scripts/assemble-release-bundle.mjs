#!/usr/bin/env node
/**
 * Assemble the release bundle the privileged publish job will consume.
 *
 * One script owns the bundle's shape so it cannot drift from the verifier's expectations. It
 * previously did not: YAML steps wrote the checksum into a directory nothing created (ENOENT on
 * the first tag), recorded the tarball's *absolute path* where the verifier requires a basename,
 * and uploaded from a different directory than the one written to. None of that was reachable from
 * ordinary CI, because tag-triggered workflows do not run there — so
 * `scripts/test-release-bundle-handoff.mjs` exercises this script and the verifier together, on a
 * real filesystem.
 *
 * Output is exactly three files, flat:
 *
 *     <package>-<version>.tgz
 *     release-sha256.txt        <sha256>  <tarball basename>
 *     release-metadata.json
 *
 * Release notes are deliberately absent: they become the GitHub Release body, so the privileged
 * job generates them from its own checkout rather than accepting them from this one.
 *
 * Node built-ins only.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { packedTarballName, releaseDistTag } from "./release-bundle-contract.mjs";
import { classifyVersion } from "./release-version-contract.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? null : process.argv[index + 1];
  if (!value) {
    console.error(`ERROR: --${name} is required`);
    process.exit(1);
  }
  return value;
}

const kind = argument("kind");
const tarball = resolve(argument("tarball"));
const manifestPath = resolve(argument("manifest"));
const tag = argument("tag");
const commit = argument("commit");
const outDir = resolve(argument("out"));
const envFileIndex = process.argv.indexOf("--env-file");
const envFile = envFileIndex === -1 ? null : process.argv[envFileIndex + 1];

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { valid } = classifyVersion(manifest.version);
if (!valid) {
  console.error(`ERROR: ${manifest.name} version ${manifest.version} is not valid SemVer`);
  process.exit(1);
}
// The channel, decided once and by the same function the verifier uses. This used to be a
// `kind === "sdk"` beta-only refusal beside a `kind === "sdk" ? "next" : distTagFor(…)` in the
// metadata below — two places, one of which knew the SDK was beta-only and the other of which
// hardcoded the answer. Both packages now follow one policy, and the case it still refuses is the
// bootstrap placeholder: a well-formed prerelease that would otherwise be routed onto `next`.
const distTag = releaseDistTag(manifest.version);
if (distTag === null) {
  console.error(
    `ERROR: ${manifest.name} ${manifest.version} is not a version this workflow releases`,
  );
  process.exit(1);
}

const expectedName = packedTarballName(manifest.name, manifest.version);
if (basename(tarball) !== expectedName) {
  console.error(`ERROR: packed ${basename(tarball)}, expected ${expectedName}`);
  process.exit(1);
}

// Fresh every time: a leftover file from an earlier attempt would be an extra bundle entry, which
// the verifier rejects — correctly, but confusingly.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

copyFileSync(tarball, join(outDir, expectedName));

const bytes = readFileSync(tarball);
const sha1 = createHash("sha1").update(bytes).digest("hex");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// Basename, not path: the verifier recomputes this line and compares it exactly.
writeFileSync(join(outDir, "release-sha256.txt"), `${sha256}  ${expectedName}\n`, "utf8");

writeFileSync(
  join(outDir, "release-metadata.json"),
  `${JSON.stringify(
    {
      package: manifest.name,
      version: manifest.version,
      spec: `${manifest.name}@${manifest.version}`,
      distTag,
      sha1,
      sha256,
      integrity,
      tag,
      commit,
      tarball: expectedName,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

if (envFile) {
  // TARBALL points into the bundle, so the smoke and audit steps operate on the exact bytes that
  // will be uploaded — not on a second copy that could diverge.
  appendFileSync(
    envFile,
    [
      `BUNDLE_DIR=${outDir}`,
      `TARBALL=${join(outDir, expectedName)}`,
      `SHA1=${sha1}`,
      `SHA256=${sha256}`,
      `INTEGRITY=${integrity}`,
      "",
    ].join("\n"),
  );
}

console.log(`✓ assembled ${kind} release bundle in ${outDir}`);
console.log(`  ${expectedName}`);
console.log("  release-sha256.txt");
console.log("  release-metadata.json");
console.log(`  SHA-256: ${sha256}`);
