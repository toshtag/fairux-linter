/**
 * What a registry canary may conclude from a dist-tag reading.
 *
 * The canaries observe one channel each and then install exactly what it named. Turning a reading
 * into that exact version is three separate decisions, and each of them used to be a shell line
 * repeated in both workflows:
 *
 * 1. **The channel resolved to something.** `npm view <pkg>@<tag>` on a channel npm has never
 *    created answers `absent`, and an install of nothing is not evidence.
 * 2. **What it resolved to is a release.** Both packages carry `latest` pointing at the
 *    `0.0.0-bootstrap.0` placeholder until their first stable release — npm sets `latest` to a
 *    package's first published version whatever `--tag` says, and refuses to remove it. Installing
 *    the placeholder would smoke a package whose whole content is a name reservation, and it would
 *    pass, because there is nothing in it to break.
 * 3. **The value is safe to carry.** It goes into `GITHUB_ENV`, where a crafted value containing a
 *    newline defines arbitrary variables for the steps that follow. A registry response is
 *    untrusted input.
 *
 * Deliberately *not* the release path's version gate. What a channel may carry is a publication
 * policy; a canary that borrowed that gate would fail the day `next` advances to an rc, with no
 * consumer-compatibility fact behind the failure. This asks only whether there is a published
 * release to install.
 *
 * The placeholder case is a refusal rather than a skip, on this repository's existing reasoning for
 * `registry-cli-smoke.yml`: a canary that passes while there is nothing to observe is worse than one
 * that reports the absence. Before the first stable release, the `latest` cell is red and says so in
 * one line.
 *
 * Pure: the caller reads the registry, this decides what the reading means.
 */

import { BOOTSTRAP_DIST_TAG } from "./release-channel-contract.mjs";
import { classifyVersion, isBootstrapPrerelease } from "./release-version-contract.mjs";

/**
 * @param {{state: unknown, spec: string}} input
 * @returns {{version: string} | {failures: string[]}}
 */
export function resolveRegistryChannel({ state, spec }) {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return { failures: [`the registry state for ${spec} is not an object`] };
  }
  const reading = /** @type {Record<string, unknown>} */ (state);

  if (reading.status !== "present") {
    const reason = typeof reading.reason === "string" ? `: ${reading.reason}` : "";
    return { failures: [`${spec} is ${String(reading.status)} on the public registry${reason}`] };
  }

  const version = reading.version;
  if (typeof version !== "string") {
    return { failures: [`the registry state for ${spec} carries no version string`] };
  }

  // The whitespace test is not redundant with the anchored SemVer grammar: a JavaScript `$` without
  // the `m` flag also matches just before a trailing newline, so `"1.0.0\n"` classifies as valid —
  // and a trailing newline is precisely the shape that turns a `GITHUB_ENV` write into an arbitrary
  // variable definition.
  if (/\s/.test(version) || !classifyVersion(version).valid) {
    return {
      failures: [`${spec} resolved to something that is not a version: ${JSON.stringify(version)}`],
    };
  }

  if (isBootstrapPrerelease(version)) {
    return {
      failures: [
        `${spec} still names the ${version} placeholder, which reserves the package name and is ` +
          `not a release. npm parks \`latest\` there on a package's first publish and refuses to ` +
          `remove it, so this channel carries nothing installable until the first stable release ` +
          `moves it. The placeholder itself stays reachable as \`${BOOTSTRAP_DIST_TAG}\`.`,
      ],
    };
  }

  return { version };
}
