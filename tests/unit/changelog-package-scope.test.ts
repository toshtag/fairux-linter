import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The production predicate, not a copy of it.
import {
  type ReleaseHeading,
  releaseHeadings,
} from "../../packages/sdk/scripts/changelog-release-entry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHANGELOG = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
const SDK_INVENTORY = readFileSync(resolve(ROOT, "docs/generated/sdk-api-inventory.md"), "utf8");

/**
 * A release section describes its own package, and not the one released beside it.
 *
 * Two packages ship from one repository and one changelog, and most of a coordinated release is
 * felt in both — the CLI's filter provenance is the SDK's `ExternalFilterRecord` seen from the
 * command line. The temptation is to write each change once and let both sections point at it, and
 * the result is a consumer of `@fairux/sdk` reading about `--stdin-filename`, or a CLI user reading
 * that a type they cannot import has gained a field.
 *
 * The sharpest case here is the one that is *not* shared. The remediation applier's overlap contract
 * changed in the same cycle, and `applyRemediations` is not exported by `@fairux/sdk` and does not
 * appear in its bundle — measured, not assumed. A section that claimed it for the SDK would be
 * describing a surface a consumer cannot reach.
 */

function sectionOf(heading: string): string {
  const start = CHANGELOG.indexOf(heading);
  expect(start, `the changelog no longer carries ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = CHANGELOG.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const textOf = (heading: ReleaseHeading) =>
  `## [${heading.name} ${heading.version}] — ${heading.date}`;

/** Every export the SDK actually ships, read from the generated inventory. */
const sdkExports = new Set(
  [...SDK_INVENTORY.matchAll(/^\| `([^`]+)`/gm)].map((match) => match[1] as string),
);

describe("each release section describes its own package", () => {
  const released = releaseHeadings(CHANGELOG);
  const sdkBeta4 = released.find(
    (heading) => heading.name === "@fairux/sdk" && heading.version === "0.1.0-beta.4",
  );
  const cliBeta2 = released.find(
    (heading) => heading.name === "fairux" && heading.version === "0.1.0-beta.2",
  );

  it("has both sections of this coordinated release", () => {
    expect(sdkBeta4, "@fairux/sdk 0.1.0-beta.4 has no section").toBeDefined();
    expect(cliBeta2, "fairux 0.1.0-beta.2 has no section").toBeDefined();
  });

  it("keeps CLI flags out of the SDK's section", () => {
    // A flag is the one thing a library consumer certainly cannot use.
    const sdk = sectionOf(textOf(sdkBeta4 as ReleaseHeading));
    for (const flag of [
      "--stdin-filename",
      "--suppress",
      "--baseline",
      "--ignore-config",
      "--fix-write",
      "--risk-index",
      "smoke:chrome",
      "smoke:vscode",
    ]) {
      expect(sdk, `the SDK section should not describe ${flag}`).not.toContain(flag);
    }
  });

  it("names only symbols the SDK actually exports", () => {
    // Read from the generated inventory, so a section cannot advertise a type that was never
    // shipped — and cannot keep advertising one after it is renamed.
    const sdk = sectionOf(textOf(sdkBeta4 as ReleaseHeading));
    const claimed = [...sdk.matchAll(/`([A-Z][A-Za-z]+)(?:\.[A-Za-z]+)?`/g)].map(
      (match) => match[1] as string,
    );
    expect(claimed.length, "the SDK section names no types at all").toBeGreaterThan(4);
    const unshipped = [...new Set(claimed)].filter((name) => !sdkExports.has(name));
    expect(unshipped, `the SDK section names symbols it does not export`).toEqual([]);
  });

  it("does not claim the remediation applier for the SDK", () => {
    // Measured: `applyRemediations` is not an export and not in the bundle. A section claiming it
    // would describe a surface a consumer cannot reach.
    const sdk = sectionOf(textOf(sdkBeta4 as ReleaseHeading));
    expect(sdkExports.has("applyRemediations")).toBe(false);
    // Named, but as what it is not — which is the useful thing to say, since the change is real and
    // a reader of both sections will wonder.
    expect(sdk).toContain("not** part of this package");
    expect(sdk).toContain("applyRemediations");
  });

  it("sends a CLI reader to the SDK's section rather than repeating its types", () => {
    const cli = sectionOf(textOf(cliBeta2 as ReleaseHeading));
    expect(cli).toContain("@fairux/sdk 0.1.0-beta.4");
    // The CLI section describes behaviour a user meets, so it may name a report field; what it must
    // not do is re-explain the type additions as if they were its own.
    for (const type of ["FairUxInputReport", "FairUxReportInput", "ExternalFilterEntry"]) {
      expect(cli, `the CLI section should leave ${type} to the SDK's section`).not.toContain(type);
    }
  });

  it("marks the one change that breaks a script, in the section that carries it", () => {
    const cli = sectionOf(textOf(cliBeta2 as ReleaseHeading));
    expect(cli).toMatch(/\*\*Breaking for a script that passed both\*\*/);
    const sdk = sectionOf(textOf(sdkBeta4 as ReleaseHeading));
    // Additive throughout is the SDK's claim, and it has to be its own.
    expect(sdk).toContain("Additive throughout");
  });

  it("keeps duplicate-edits out of both sections as a user-facing change", () => {
    // Added and removed before either package published it. Calling it breaking would invent a
    // contract nobody had; leaving it unmentioned would puzzle anyone reading the commits.
    const cli = sectionOf(textOf(cliBeta2 as ReleaseHeading));
    const at = cli.indexOf("duplicate-edits");
    expect(at, "duplicate-edits should be noted as development history").toBeGreaterThan(0);
    expect(cli.slice(at, at + 300)).toMatch(/No published version ever carried it/);
    expect(sectionOf(textOf(sdkBeta4 as ReleaseHeading))).not.toContain("duplicate-edits");
  });

  it("leaves the previously released sections alone", () => {
    // beta.1 and beta.3 are fixed records. This release does not get to edit them.
    for (const heading of [
      "## [fairux 0.1.0-beta.1] — 2026-08-06",
      "## [@fairux/sdk 0.1.0-beta.3] — 2026-08-01",
    ]) {
      expect(CHANGELOG).toContain(heading);
    }
    expect(sectionOf("## [fairux 0.1.0-beta.1] — 2026-08-06")).toContain("What shipped in it");
  });

  it("leaves an Unreleased section that claims nothing", () => {
    const unreleased = sectionOf("## [Unreleased]");
    expect(unreleased).toMatch(/Nothing yet/);
    expect(unreleased).not.toMatch(/^### /m);
  });
});
