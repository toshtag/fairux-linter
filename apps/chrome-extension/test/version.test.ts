import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import manifest from "../static/manifest.json";

/**
 * Extension version single-source-of-truth (P10-T3). The Chrome extension is versioned
 * INDEPENDENTLY of the CLI (see README), but within the extension the manifest is the single
 * source: content.ts reads `chrome.runtime.getManifest().version` at runtime for report.toolVersion,
 * so it can't drift from what Chrome shows. package.json is the dev-facing version; this test keeps
 * the two in lockstep so a release bump to one without the other fails CI.
 */

describe("Chrome extension version (manifest is the single source)", () => {
  it("manifest.json version === package.json version", () => {
    expect(manifest.version).toBe(pkg.version);
  });
});
