#!/usr/bin/env node
/**
 * Refuse anything that is not exactly one strict SemVer 2.0.0 version — and nothing narrower.
 *
 * `check-sdk-release-version.mjs` is the P20 SDK *release* gate: it also refuses every prerelease
 * that is not a beta, because the SDK release path, its notes, and its `next` dist-tag all
 * describe a beta. The registry consumer workflow briefly borrowed it for input validation, which
 * coupled a consumer observation to a publication policy: the day `@fairux/sdk@next` advances to
 * an rc or a stable version, the canary would have failed with no consumer-compatibility fact
 * behind it. What that workflow actually needs is different and narrower — the resolved version is
 * untrusted registry input on its way into `GITHUB_ENV`, so it must be one strict SemVer version:
 * no whitespace, no shell fragment, no `v` prefix, no trailing newline.
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
