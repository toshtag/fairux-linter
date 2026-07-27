/**
 * Derive the manifest a packed tarball must contain, from the trusted checkout.
 *
 * The previous contract pinned a hand-picked list of fields, which meant every field *not* on the
 * list was free. Reproduced against the real SDK tarball: adding `os: ["!darwin"]`, `cpu`, `libc`,
 * `module`, and `bundleDependencies` to the packed manifest audited clean. `os`/`cpu`/`libc` decide
 * which machines may install the package at all; `bundleDependencies` changes what the tarball is
 * contractually carrying. A list of fields to check is the wrong shape for this — the question is
 * whether the packed manifest *is* the checkout's, so the answer is a whole-object comparison.
 *
 * That only works if every transform the packer performs is known. Measured against
 * `pnpm@10.33.2 pack` for both publishable packages, it performs exactly two:
 *
 *   1. it removes the publish-lifecycle scripts, and
 *   2. it resolves `workspace:` ranges to the referenced workspace's own version.
 *
 * Anything else the packer starts doing stops a release until someone looks at the tarball and
 * updates this file — which is the intended failure mode, not an inconvenience.
 */

/** Scripts a packer may remove because they belong to publishing, not to the published package. */
const PUBLISH_LIFECYCLE_SCRIPTS = Object.freeze([
  "prepack",
  "postpack",
  "prepublishOnly",
  "publish",
  "postpublish",
]);

/**
 * Scripts that run on a consumer's machine. None of these may exist in the checkout or the tarball.
 *
 * `prepublish` is here despite its name: npm deprecated it precisely because it runs on
 * `npm install` and `npm ci`, not only on publish. `dependencies` runs whenever an install changes
 * `node_modules`.
 */
export const INSTALL_TIME_SCRIPTS = Object.freeze([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
]);

const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

/** Order-independent deep comparison of two JSON values. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Resolve one dependency range as the packer would.
 *
 * `workspace:*` becomes the referenced package's own version. Nothing else is a legal resolution:
 * a packer that produced `*`, a URL, or an `npm:` alias here would be publishing a range the
 * checkout never declared, and "it is no longer a workspace range" is not the property that matters.
 */
function resolveRange(name, range, workspaceVersions) {
  if (typeof range !== "string" || !range.startsWith("workspace:")) return range;
  if (range !== "workspace:*") {
    // `workspace:^` and `workspace:~` resolve differently. Nothing here uses them; when something
    // does, measure the real transform and add it rather than guessing.
    throw new Error(`unsupported workspace protocol form for ${name}: ${range}`);
  }
  const version = workspaceVersions[name];
  if (typeof version !== "string" || version === "") {
    throw new Error(`no workspace version known for ${name}`);
  }
  return version;
}

/**
 * @param {object} input
 * @param {object} input.sourceManifest  the manifest from the trusted checkout
 * @param {Record<string, string>} input.workspaceVersions  name → version, from the same checkout
 * @returns {{manifest: object|null, failures: string[]}} `manifest` is null when the checkout
 *   itself is disqualifying, so a caller never compares against an expectation built from it
 */
export function expectedPackedManifest({ sourceManifest, workspaceVersions }) {
  const failures = [];

  const sourceScripts = sourceManifest.scripts ?? {};
  for (const name of INSTALL_TIME_SCRIPTS) {
    if (Object.hasOwn(sourceScripts, name)) {
      failures.push(`source manifest defines an install-time script: ${name}`);
    }
  }
  if (failures.length > 0) return { manifest: null, failures };

  const expected = { ...sourceManifest };

  const scripts = { ...sourceScripts };
  for (const name of PUBLISH_LIFECYCLE_SCRIPTS) delete scripts[name];
  if (Object.hasOwn(sourceManifest, "scripts")) expected.scripts = scripts;

  for (const field of DEPENDENCY_FIELDS) {
    const map = sourceManifest[field];
    if (!map) continue;
    const resolved = {};
    for (const [name, range] of Object.entries(map)) {
      try {
        resolved[name] = resolveRange(name, range, workspaceVersions);
      } catch (error) {
        failures.push(`${field}: ${error.message}`);
      }
    }
    expected[field] = resolved;
  }

  return failures.length > 0 ? { manifest: null, failures } : { manifest: expected, failures };
}
