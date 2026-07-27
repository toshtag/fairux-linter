import { classifyVersion } from "./release-version-contract.mjs";

/**
 * Release bundle contract — what the privileged publish job may believe about an artifact.
 *
 * The bundle is built by an unprivileged `prepare` job, precisely so that dependency and package
 * lifecycle scripts never run while an OIDC token can be minted. The consequence is that the
 * bundle is **untrusted input**: anything in it may have been written by that lifecycle code.
 *
 * Two earlier versions of this boundary leaked:
 *
 * - The verifier printed `export KEY='value'` and the workflow ran `eval` on it. A `distTag` of
 *   `next'; touch /tmp/PWNED; echo '` executed in the job holding `id-token: write` — reproduced,
 *   marker file and all. Nothing here emits shell, and every value that leaves this module is
 *   rejected if it contains a quote, a newline, a carriage return, or a NUL.
 * - The dist-tag, expected tag, and tarball name were read *from* the bundle. A `prepare` job that
 *   wrote `"distTag": "latest"` would have published a beta to `latest`. All three are now derived
 *   from the checked-out manifest, and the bundle's copies are only compared against them.
 *
 * What the bundle is still allowed to supply: nothing. Digests are recomputed from the bytes; the
 * file set, checksum line, and every metadata field are checked against values derived here — and
 * every entry must be a regular file, since a directory or a symlink named `release-metadata.json`
 * is not the thing this contract claims to have checked.
 */

/** Package identity per release kind, derived from the checked-out manifest — never the bundle. */
const KINDS = Object.freeze({
  sdk: {
    packageName: "@fairux/sdk",
    tagPrefix: "sdk-v",
    /** P20 is beta-only: a stable SDK version must not reach this workflow at all. */
    distTag: (version) => (classifyVersion(version).prerelease ? "next" : null),
  },
  cli: {
    packageName: "fairux",
    tagPrefix: "v",
    distTag: (version) => (classifyVersion(version).prerelease ? "next" : "latest"),
  },
});

/**
 * Files every bundle must contain, beyond the tarball — and the only ones it may contain.
 *
 * Release notes are not here on purpose. They used to ride along in the SDK bundle and become the
 * GitHub Release body, which made prose written by an unprivileged job into published output. The
 * privileged job now generates them from its own checkout.
 */
const BASE_FILES = Object.freeze(["release-sha256.txt", "release-metadata.json"]);

/** Metadata keys the contract knows. Anything else is refused rather than ignored. */
const METADATA_KEYS = Object.freeze([
  "package",
  "version",
  "spec",
  "distTag",
  "sha1",
  "sha256",
  "integrity",
  "tag",
  "commit",
  "tarball",
]);

/**
 * The filename `npm pack` produces, derived rather than observed.
 *
 * `@fairux/sdk` + `0.1.0-beta.2` → `fairux-sdk-0.1.0-beta.2.tgz`.
 */
export function packedTarballName(packageName, version) {
  return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/** Values crossing into a privileged shell must be inert. */
function assertInert(label, value) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} is missing or not a string`);
  }
  if (/["'`$\\\r\n\0]/.test(value)) {
    throw new Error(`${label} contains a quote, backslash, newline, or control character`);
  }
}

/**
 * Verify a downloaded release bundle and return the values the publish job may use.
 *
 * @param {object} input
 * @param {"sdk"|"cli"} input.kind
 * @param {string} input.tag  the tag this run was triggered by
 * @param {string} input.commit  the commit this run is building
 * @param {{name: string, version: string}} input.manifest  from the trusted checkout
 * @param {readonly {name: string, kind: "file"|"directory"|"symlink"|"other"}[]} input.entries
 *   bundle directory entries, top level only, each with its filesystem kind
 * @param {(name: string) => string} input.readText  reads a bundle file as UTF-8
 * @param {(name: string) => Buffer|Uint8Array} input.readBytes  reads a bundle file as bytes
 * @param {(bytes: Buffer|Uint8Array) => {sha1: string, sha256: string, integrity: string}} input.digest
 * @returns {{tarball: string, version: string, spec: string, distTag: string,
 *   sha1: string, sha256: string, integrity: string}}
 */
export function verifyReleaseBundle({
  kind,
  tag,
  commit,
  manifest,
  entries,
  readText,
  readBytes,
  digest,
}) {
  const contract = KINDS[kind];
  if (!contract) throw new Error(`unknown release kind: ${kind}`);

  // --- Everything expected is derived here, from the trusted checkout ----------------------
  if (manifest.name !== contract.packageName) {
    throw new Error(
      `checkout builds ${manifest.name}, this workflow releases ${contract.packageName}`,
    );
  }
  const version = manifest.version;
  if (!classifyVersion(version).valid) {
    throw new Error(`${contract.packageName} version is not valid SemVer`);
  }
  const distTag = contract.distTag(version);
  if (distTag === null) {
    throw new Error(
      `${contract.packageName} ${version} is not a prerelease; this workflow is beta-only`,
    );
  }
  const expectedTag = `${contract.tagPrefix}${version}`;
  const expectedTarball = packedTarballName(contract.packageName, version);
  const expectedSpec = `${contract.packageName}@${version}`;
  const expectedFiles = [expectedTarball, ...BASE_FILES].sort();

  if (tag !== expectedTag) {
    throw new Error(`run tag ${tag} does not match the manifest version (expected ${expectedTag})`);
  }

  // --- The bundle must be exactly what was expected, no more --------------------------------
  // Kind first. A previous version listed names only and dropped anything that was not a regular
  // file, so a bundle could carry a directory tree or a symlink into the runner alongside the
  // three expected names and still be called verified.
  const irregular = entries.filter((entry) => entry.kind !== "file").map((entry) => entry.name);
  if (irregular.length > 0) {
    throw new Error(
      `bundle contains entries that are not regular files: ${irregular.sort().join(", ")}`,
    );
  }

  const actualFiles = entries.map((entry) => entry.name).sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error(
      `bundle contents do not match the contract.\n  expected: ${expectedFiles.join(", ")}\n  actual:   ${actualFiles.join(", ")}`,
    );
  }

  // --- Digests come from the bytes, never from the metadata --------------------------------
  const { sha1, sha256, integrity } = digest(readBytes(expectedTarball));

  const expectedChecksum = `${sha256}  ${expectedTarball}\n`;
  if (readText("release-sha256.txt") !== expectedChecksum) {
    throw new Error("release-sha256.txt is not exactly '<sha256>  <tarball>' for the packed bytes");
  }

  // --- The metadata may only agree; it may not decide --------------------------------------
  let metadata;
  try {
    metadata = JSON.parse(readText("release-metadata.json"));
  } catch (error) {
    throw new Error(`release-metadata.json is not valid JSON: ${error.message}`);
  }

  const unknown = Object.keys(metadata).filter((key) => !METADATA_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`release-metadata.json has unexpected keys: ${unknown.join(", ")}`);
  }

  for (const [key, expected] of Object.entries({
    package: contract.packageName,
    version,
    spec: expectedSpec,
    distTag,
    sha1,
    sha256,
    integrity,
    tag: expectedTag,
    commit,
    tarball: expectedTarball,
  })) {
    if (metadata[key] !== expected) {
      // Values are compared, not printed: a mismatched field is attacker-controlled text.
      throw new Error(
        `release-metadata.json ${key} does not match the value derived from the checkout`,
      );
    }
  }

  const verified = {
    tarball: expectedTarball,
    version,
    spec: expectedSpec,
    distTag,
    sha1,
    sha256,
    integrity,
  };
  for (const [label, value] of Object.entries(verified)) assertInert(label, value);
  return verified;
}
