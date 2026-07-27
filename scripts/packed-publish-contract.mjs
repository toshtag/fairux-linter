/**
 * What a packed tarball may contain before the privileged job publishes it.
 *
 * The existing per-package audits check identity and payload — name, version, dependency ranges,
 * the file allowlist. Two things they did not check, both reachable by the unprivileged `prepare`
 * job that runs `prepack`:
 *
 * - **Install-time lifecycle scripts.** `postinstall` in the published manifest runs on every
 *   consumer's machine at `npm install`. `auditPackedCliTarball` never looked at `scripts` at all,
 *   so a `prepack` that added one would have shipped. Nothing in this repo needs an install hook,
 *   so the rule is a flat refusal rather than a review.
 * - **Archive members that are not regular files, and members that are not uniquely named.**
 *   `tar -tzf` prints a name and nothing else, so a symlink, hardlink, or device node lists exactly
 *   like the file it impersonates. Worse, a *name* does not identify a member: two members may
 *   carry the same path, or paths that differ only in a `.` segment, and extraction keeps the last
 *   one while `tar -xzOf <path>` hands the auditor all of them concatenated. Both were reproduced
 *   against the real SDK tarball: a first `package/dist/dom.js` of `//` and a second containing
 *   `import "node:fs";` audited clean and extracted malicious. A real `pnpm pack` of these packages
 *   produces uniquely named, canonical, regular files only — verified, 14 of 14 for the SDK — so
 *   anything else is a finding, not a variation.
 *
 * Both functions are pure and take already-read inputs, so the tests drive them with hostile
 * fixtures the packer would never produce.
 *
 * The manifest comparison is a whole-object deep-equal against an expectation derived in
 * `expected-packed-manifest.mjs`; see there for why a list of pinned fields was the wrong shape.
 */
import {
  deepEqual,
  expectedPackedManifest,
  INSTALL_TIME_SCRIPTS,
} from "./expected-packed-manifest.mjs";

/**
 * Compare a packed manifest against the manifest the trusted checkout implies.
 *
 * @param {object} input
 * @param {object} input.manifest  parsed `package/package.json` from the tarball
 * @param {object} input.sourceManifest  parsed manifest from the tagged checkout
 * @param {Record<string, string>} input.workspaceVersions  name → version, same checkout
 * @returns {string[]} failures; empty means the packed manifest is the checkout's
 */
export function auditPublishedManifest({ manifest, sourceManifest, workspaceVersions }) {
  const { manifest: expected, failures } = expectedPackedManifest({
    sourceManifest,
    workspaceVersions,
  });
  if (expected === null) return failures;

  // Install-time scripts are refused in the checkout by `expectedPackedManifest`; the tarball may
  // still have gained one that the checkout never had, and that is worth naming as such rather
  // than reporting only "the scripts object differs".
  const packedScripts = manifest.scripts ?? {};
  for (const name of INSTALL_TIME_SCRIPTS) {
    if (Object.hasOwn(packedScripts, name)) {
      failures.push(`packed manifest defines an install-time script: ${name}`);
    }
  }

  if (deepEqual(manifest, expected)) return failures;

  // Name the fields that differ. Values are not printed: a mismatched field is attacker-controlled
  // text, and the reader has both manifests in hand.
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(manifest)])].sort()) {
    if (deepEqual(expected[key], manifest[key])) continue;
    if (!Object.hasOwn(manifest, key)) {
      failures.push(`packed manifest is missing ${key}`);
    } else if (!Object.hasOwn(expected, key)) {
      failures.push(`packed manifest adds ${key}, which the checkout does not declare`);
    } else {
      failures.push(`packed manifest ${key} does not match the checkout`);
    }
  }

  return failures;
}

/**
 * Normalize a POSIX tar path the way an extractor resolves it.
 *
 * Deliberately hand-written rather than `path.posix.normalize`: this must describe the archive's
 * own grammar, not the host's, and it must not silently absorb a leading slash or a `..`.
 */
function canonicalize(name) {
  const segments = [];
  for (const segment of name.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Check every archive member's type and path, and that no two members name the same file.
 *
 * @param {readonly {name: string, type: string, linkname: string}[]} members  from `readTarMembers`
 * @returns {{failures: string[], names: string[]}} `names` is the validated member list, relative
 *   to `package/`, and is empty whenever `failures` is not — a caller must never read content from
 *   an archive whose paths did not verify.
 */
export function auditTarMembers(members) {
  const failures = [];

  if (members.length === 0) {
    return { failures: ["tarball has no members"], names: [] };
  }

  const seenExact = new Map();
  const seenCanonical = new Map();
  const seenPortable = new Map();

  for (const member of members) {
    const name = member.name;

    if (member.type !== "file") {
      // Includes symlink, hardlink, device, fifo, directory, and pax/GNU extension headers. A real
      // `pnpm pack` of these packages emits regular files only.
      failures.push(`tarball member ${name} is a ${member.type}, not a regular file`);
      continue;
    }
    if (member.linkname !== "") {
      failures.push(`tarball member ${name} carries a link target`);
    }

    // --- The path must be exactly what it appears to be -------------------------------------
    if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) {
      failures.push(`tarball member ${name} is an absolute path`);
    }
    if (name.includes("\\")) {
      failures.push(`tarball member ${name} contains a backslash`);
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      failures.push("tarball member name contains a control character");
    }
    if (name.endsWith("/")) {
      failures.push(`tarball member ${name} has a trailing slash but is typed as a regular file`);
    }
    const segments = name.split("/");
    if (segments.includes("..")) {
      failures.push(`tarball member ${name} escapes its root with ..`);
    }
    if (segments.includes(".")) {
      // `package/dist/./dom.js` audits as a distinct member and extracts over `package/dist/dom.js`.
      failures.push(`tarball member ${name} contains a "." segment`);
    }
    if (segments.some((segment) => segment === "") && name !== "") {
      failures.push(`tarball member ${name} contains an empty path segment`);
    }

    const canonical = canonicalize(name);
    if (canonical !== name) {
      failures.push(`tarball member ${name} is not in canonical form`);
    }
    if (!name.startsWith("package/") || name === "package/") {
      failures.push(`tarball member ${name} is outside the package/ root`);
    }

    // --- No two members may resolve to the same file ------------------------------------------
    // Reported once per collision, at the most specific level that catches it: an exact duplicate
    // is not also worth reporting as a canonical collision and again as a case collision.
    const portable = canonical
      .split("/")
      .map((segment) => segment.toLowerCase())
      .join("/");
    if (seenExact.has(name)) {
      failures.push(`tarball contains ${name} more than once`);
    } else if (seenCanonical.has(canonical)) {
      failures.push(
        `tarball members ${seenCanonical.get(canonical)} and ${name} resolve to the same path`,
      );
    } else if (seenPortable.has(portable)) {
      failures.push(
        `tarball members ${seenPortable.get(portable)} and ${name} collide on a case-insensitive filesystem`,
      );
    }
    seenExact.set(name, name);
    seenCanonical.set(canonical, name);
    seenPortable.set(portable, name);
  }

  return {
    failures,
    // Relative to `package/`, matching what the payload audits expect — and empty on any failure,
    // so an ambiguous archive can never reach a content reader.
    names: failures.length > 0 ? [] : members.map((member) => member.name.slice("package/".length)),
  };
}
