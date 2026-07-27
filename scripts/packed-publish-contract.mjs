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
 * - **Archive members that are not regular files.** `tar -tzf` prints a name and nothing else, and
 *   a symlink, hardlink, or device node lists exactly like the file it impersonates. A real
 *   `npm pack` of these packages produces regular files only — verified, 14 of 14 for the SDK — so
 *   anything else is a finding, not a variation.
 *
 * Both functions are pure and take already-read inputs, so the tests drive them with hostile
 * fixtures the packer would never produce.
 *
 * The comparison rules below are shaped by what `pnpm pack` actually does, checked against real
 * tarballs of both packages rather than assumed: it **removes** the publish-lifecycle scripts, and
 * it **resolves** `workspace:` ranges to concrete versions. A plain deep-equal against the checkout
 * would fail every honest release. Everything else must still match exactly.
 */

/** Scripts npm runs on the consumer's machine, or on install from a git ref. Never ours. */
const INSTALL_TIME_SCRIPTS = Object.freeze([
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
]);

/**
 * Scripts a packer may legitimately drop, because they belong to publishing rather than to the
 * published package. `pnpm pack` removes these; `npm pack` keeps them. Either is acceptable, and
 * anything else missing is not.
 */
const PACKER_MAY_STRIP = Object.freeze([
  "prepack",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
]);

/** Package-specific shape, pinned from the source manifest rather than restated here. */
const PUBLISHED = Object.freeze({
  cli: {
    packageName: "fairux",
    pinned: ["bin", "files", "publishConfig", "type", "license", "engines"],
    requireExports: false,
  },
  sdk: {
    packageName: "@fairux/sdk",
    pinned: ["main", "exports", "files", "publishConfig", "type", "license", "engines", "types"],
    requireExports: true,
  },
});

const stable = (value) => JSON.stringify(value ?? null);

/**
 * Compare a packed manifest against the manifest in the trusted checkout.
 *
 * @param {object} input
 * @param {"sdk"|"cli"} input.kind
 * @param {object} input.manifest  parsed `package/package.json` from the tarball
 * @param {object} input.sourceManifest  parsed manifest from the tagged checkout
 * @returns {string[]} failures; empty means the manifest satisfies the contract
 */
export function auditPublishedManifest({ kind, manifest, sourceManifest }) {
  const contract = PUBLISHED[kind];
  if (!contract) return [`unknown package kind: ${kind}`];
  const failures = [];

  if (manifest.name !== contract.packageName) {
    failures.push(`packed manifest name is ${manifest.name}, expected ${contract.packageName}`);
  }

  // --- No install hooks, in the tarball or in the checkout -----------------------------------
  const packedScripts = manifest.scripts ?? {};
  for (const name of INSTALL_TIME_SCRIPTS) {
    if (Object.hasOwn(packedScripts, name)) {
      failures.push(`packed manifest defines an install-time script: ${name}`);
    }
    if (Object.hasOwn(sourceManifest.scripts ?? {}, name)) {
      failures.push(`source manifest defines an install-time script: ${name}`);
    }
  }

  // --- The script table is the checkout's, minus what a packer may strip ----------------------
  const sourceScripts = sourceManifest.scripts ?? {};
  for (const [name, command] of Object.entries(sourceScripts)) {
    if (!Object.hasOwn(packedScripts, name)) {
      if (!PACKER_MAY_STRIP.includes(name)) {
        failures.push(`packed manifest is missing the ${name} script`);
      }
      continue;
    }
    if (packedScripts[name] !== command) {
      failures.push(`packed manifest ${name} script does not match the source manifest`);
    }
  }
  for (const name of Object.keys(packedScripts)) {
    if (!Object.hasOwn(sourceScripts, name)) {
      failures.push(`packed manifest adds a script the checkout does not have: ${name}`);
    }
  }

  // --- Fields that decide what consumers load -------------------------------------------------
  for (const field of contract.pinned) {
    if (stable(manifest[field]) !== stable(sourceManifest[field])) {
      failures.push(`packed manifest ${field} does not match the source manifest`);
    }
  }

  // --- Dependency maps, all four ---------------------------------------------------------------
  // Names must match exactly. Ranges must match exactly too, except where the checkout used the
  // `workspace:` protocol — the packer resolves those, and must resolve them to something that is
  // no longer a workspace reference, since a published `workspace:*` is uninstallable.
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const source = sourceManifest[field] ?? {};
    const packed = manifest[field] ?? {};
    const names = [...new Set([...Object.keys(source), ...Object.keys(packed)])].sort();
    for (const name of names) {
      if (!Object.hasOwn(packed, name)) {
        failures.push(`packed manifest ${field} drops ${name}`);
        continue;
      }
      if (!Object.hasOwn(source, name)) {
        failures.push(`packed manifest ${field} adds ${name}, which the checkout does not declare`);
        continue;
      }
      if (String(packed[name]).startsWith("workspace:")) {
        failures.push(
          `packed manifest ${field} publishes an unresolved workspace range for ${name}`,
        );
        continue;
      }
      if (String(source[name]).startsWith("workspace:")) continue; // resolved by the packer
      if (packed[name] !== source[name]) {
        failures.push(
          `packed manifest ${field} range for ${name} does not match the source manifest`,
        );
      }
    }
  }

  if (contract.requireExports && !manifest.exports) {
    failures.push("packed manifest has no exports map");
  }
  if (manifest.private === true) {
    failures.push("packed manifest is marked private");
  }

  return failures;
}

/**
 * Check every archive member's type and path.
 *
 * @param {readonly {name: string, type: string, linkname: string}[]} members  from `readTarMembers`
 * @returns {string[]} failures; empty means every member is an ordinary file under `package/`
 */
export function auditTarMembers(members) {
  const failures = [];

  if (members.length === 0) {
    return ["tarball has no members"];
  }

  for (const member of members) {
    const name = member.name;

    if (member.type !== "file") {
      // Includes symlink, hardlink, device, fifo, directory, and pax/GNU extension headers. A real
      // `npm pack` of these packages emits regular files only.
      failures.push(`tarball member ${name} is a ${member.type}, not a regular file`);
      continue;
    }
    if (member.linkname !== "") {
      failures.push(`tarball member ${name} carries a link target`);
    }
    if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) {
      failures.push(`tarball member ${name} is an absolute path`);
    }
    if (name.split("/").includes("..")) {
      failures.push(`tarball member ${name} escapes its root with ..`);
    }
    if (name.includes("\\")) {
      failures.push(`tarball member ${name} contains a backslash`);
    }
    if (!name.startsWith("package/")) {
      failures.push(`tarball member ${name} is outside the package/ root`);
    }
  }

  return failures;
}
