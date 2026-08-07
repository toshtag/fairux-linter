#!/usr/bin/env node
/**
 * Refuse anything that is not exactly one strict SemVer 2.0.0 version — and nothing narrower.
 *
 * `packages/sdk/scripts/check-sdk-release-version.mjs` is the SDK *release* gate: it decides which
 * versions this repository will publish and where. The registry consumer workflow briefly borrowed
 * it for input validation, which coupled a consumer observation to a publication policy — the day
 * `@fairux/sdk@next` advanced to something that gate refused, the canary would have failed with no
 * consumer-compatibility fact behind it. What that workflow actually needs is different and
 * narrower: the resolved version is untrusted registry input on its way into `GITHUB_ENV`, so it
 * must be one strict SemVer version — no whitespace, no shell fragment, no `v` prefix, no trailing
 * newline.
 *
 * The canaries reach that rule through `scripts/registry-channel-contract.mjs` now, which adds the
 * two questions a bare SemVer check cannot answer: did the channel resolve to anything, and is what
 * it resolved to a release rather than the name-reservation placeholder `latest` holds before a
 * package's first stable version. This entry point stays for callers that only need the grammar.
 *
 * The SemVer grammar is `classifyVersion`'s, shared with the release contract rather than spelled
 * again. The explicit whitespace check is not redundant with that anchored regex: a JavaScript `$`
 * without the `m` flag also matches just before a trailing newline, so `"1.0.0\n"` classifies as
 * valid — and a trailing newline is precisely the shape that turns a `GITHUB_ENV` write into an
 * arbitrary variable definition.
 *
 * Node built-ins only.
 */
import { classifyVersion } from "./release-version-contract.mjs";

const version = process.argv[2];

if (version === undefined) {
  console.error("Usage: check-semver.mjs <version>");
  process.exit(2);
}

if (/\s/.test(version) || !classifyVersion(version).valid) {
  console.error(`ERROR: not a strict SemVer version: ${JSON.stringify(version)}`);
  process.exit(1);
}

console.log(`✓ ${version} is a strict SemVer version`);
