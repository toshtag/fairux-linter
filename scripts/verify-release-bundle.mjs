#!/usr/bin/env node
/**
 * Verify a downloaded release bundle inside the privileged publish job.
 *
 * Decisions live in `release-bundle-contract.mjs`, which explains why the bundle is untrusted.
 * This entrypoint only supplies the filesystem and, on success, writes the verified values to
 * `GITHUB_ENV`.
 *
 * It writes **no shell code to stdout**. An earlier version printed `export KEY='value'` for the
 * workflow to `eval`, and a `distTag` of `next'; touch /tmp/PWNED; echo '` in the bundle executed
 * in the job holding `id-token: write`. Nothing here is meant to be `eval`ed.
 *
 * Node built-ins only: this runs where no dependency tree may exist.
 */
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifyReleaseBundle } from "./release-bundle-contract.mjs";

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? null : process.argv[index + 1];
  if (required && !value) {
    console.error(`ERROR: --${name} is required`);
    process.exit(1);
  }
  return value;
}

const kind = argument("kind");
const bundleDir = resolve(argument("bundle"));
const tag = argument("tag");
const commit = argument("commit");
const manifestPath = resolve(argument("package-json"));
const githubEnv = argument("github-env", { required: false });

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Every top-level entry is reported with its kind, and the contract refuses anything that is not a
// regular file. This used to *filter* non-files out instead, so a bundle carrying a directory or a
// symlink alongside the three expected names passed as if it held only those three.
//
// `lstatSync`, not `statSync`: a symlink to a regular file must read as a symlink.
const entries = readdirSync(bundleDir, { withFileTypes: true }).map((entry) => {
  const stats = lstatSync(join(bundleDir, entry.name), { throwIfNoEntry: false });
  let kind = "other";
  if (stats?.isSymbolicLink()) kind = "symlink";
  else if (stats?.isDirectory()) kind = "directory";
  else if (stats?.isFile()) kind = "file";
  return { name: entry.name, kind };
});

let verified;
try {
  verified = verifyReleaseBundle({
    kind,
    tag,
    commit,
    manifest: { name: manifest.name, version: manifest.version },
    entries,
    readText: (name) => readFileSync(join(bundleDir, name), "utf8"),
    readBytes: (name) => readFileSync(join(bundleDir, name)),
    digest: (bytes) => ({
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    }),
  });
} catch (error) {
  console.error(`ERROR: release bundle rejected — ${error.message}`);
  process.exit(1);
}

const exported = {
  TARBALL: join(bundleDir, verified.tarball),
  VERSION: verified.version,
  SPEC: verified.spec,
  DIST_TAG: verified.distTag,
  SHA1: verified.sha1,
  SHA256: verified.sha256,
  INTEGRITY: verified.integrity,
};

if (githubEnv) {
  appendFileSync(
    githubEnv,
    `${Object.entries(exported)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

console.log(`✓ release bundle verified for ${verified.spec} (${tag} @ ${commit})`);
console.log(`  tarball:  ${verified.tarball}`);
console.log(`  dist-tag: ${verified.distTag}  (derived from the checked-out manifest)`);
console.log(`  SHA-256:  ${verified.sha256}`);
