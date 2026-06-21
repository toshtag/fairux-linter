import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import manifest from "../static/manifest.json";

/**
 * Extension version single-source-of-truth (P10-T3). The Chrome extension is versioned
 * INDEPENDENTLY of the CLI (see README). manifest.json is the CANONICAL version (content.ts reads
 * `chrome.runtime.getManifest().version` at runtime for report.toolVersion, so it can't drift from
 * what Chrome shows); package.json is a dev-facing MIRROR. This test forces the mirror to track the
 * canonical source AND enforces Chrome's manifest version grammar — so a release bump to an invalid
 * value (e.g. a SemVer prerelease) fails CI here instead of at "Load unpacked".
 */

// Chrome's version grammar: 1–4 dot-separated integers, each 0–65535, no leading zeros on a
// non-zero part, and not all-zero. NOT general SemVer — prerelease/build tags belong in
// `version_name`, not `version`. https://developer.chrome.com/docs/extensions/reference/manifest/version
function expectValidChromeVersion(version: string): void {
  const parts = version.split(".");
  expect(parts.length).toBeGreaterThanOrEqual(1);
  expect(parts.length).toBeLessThanOrEqual(4);
  for (const part of parts) {
    expect(part).toMatch(/^(0|[1-9]\d*)$/);
    expect(Number(part)).toBeLessThanOrEqual(65535);
  }
  expect(parts.some((part) => Number(part) !== 0)).toBe(true);
}

describe("Chrome extension version (manifest is the canonical source)", () => {
  it("package.json version mirrors manifest.json version", () => {
    expect(pkg.version).toBe(manifest.version);
  });

  it("manifest version satisfies Chrome's version grammar", () => {
    expectValidChromeVersion(manifest.version);
  });
});
