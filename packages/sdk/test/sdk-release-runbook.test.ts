import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The runbook's *active* instructions, as a contract.
 *
 * A runbook that hard-codes the last release's version tells the next maintainer to tag something
 * already published. That is not hypothetical: after the bump to `0.1.0-beta.3` the Local Preflight
 * still ran `--tag sdk-v0.1.0-beta.2`, which fails the release check, and the Approval Boundary
 * still named the beta.2 tag — the one command in the document where being wrong is irreversible.
 *
 * The check is **section-scoped**, not a whole-file grep. The Release attempt history is supposed to
 * name `beta.1` and `beta.2`: it records what happened. A file-wide assertion would have to choose
 * between forbidding that history and permitting a stale instruction, and neither is the contract.
 */

const root = resolve(import.meta.dirname, "../../..");
const runbook = readFileSync(resolve(root, "docs/sdk-beta-release.md"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "packages/sdk/package.json"), "utf8")) as {
  version: string;
};

/**
 * The text under one `##` heading, up to the next one.
 *
 * Headings are matched at column zero, the same rule `sdk-publication-status.mjs` applies to its
 * record: an indented heading is list content rather than the document's own structure.
 */
function section(heading: string): string {
  const lines = runbook.split("\n");
  const start = lines.findIndex((line) => line === `## ${heading}`);
  if (start < 0) throw new Error(`runbook has no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Any literal `sdk-v<semver>` or `fairux-sdk-<semver>.tgz` written out instead of derived. */
const LITERAL_TAG = /sdk-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;
const LITERAL_TARBALL = /fairux-sdk-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz/g;

describe("the runbook's active instructions derive their version from the manifest", () => {
  const preflight = section("Local Preflight");
  const approval = section("Approval Boundary");

  it("defines the variables before using them", () => {
    expect(preflight).toContain("packages/sdk/package.json').version");
    expect(preflight).toContain('SDK_TAG="sdk-v${SDK_VERSION}"');
    expect(preflight).toContain('SDK_TARBALL="fairux-sdk-${SDK_VERSION}.tgz"');
  });

  it("runs both release commands against the derived tag", () => {
    expect(preflight).toContain('pnpm release:check:sdk -- --tag "$SDK_TAG"');
    expect(preflight).toContain('pnpm release:dry-run:sdk -- --tag "$SDK_TAG"');
  });

  it("names no literal version in the preflight", () => {
    // Including the tarball example: a maintainer copying it would smoke the wrong artifact.
    expect(preflight.match(LITERAL_TAG)).toBeNull();
    expect(preflight.match(LITERAL_TARBALL)).toBeNull();
  });

  it("names no literal tag in the approval boundary", () => {
    // The one place in this document where being wrong is irreversible.
    expect(approval.match(LITERAL_TAG)).toBeNull();
    expect(approval).toContain('git tag "$SDK_TAG"');
    expect(approval).toContain('git push origin "$SDK_TAG"');
  });

  it("re-derives and shows the tag immediately before approval", () => {
    // A shell that has been open for an hour is not evidence about the current manifest.
    expect(approval).toContain("about to tag");
    expect(approval).toContain('git ls-remote --tags origin "$SDK_TAG"');
  });
});

describe("the runbook's version-specific sections match the manifest", () => {
  it("names the prepared version in its publishing section", () => {
    // This one is deliberately literal: it is about one release, and a reader needs to see which.
    expect(runbook).toContain(`### Publishing \`${manifest.version}\``);
    expect(section("What the next version bump must carry")).toContain(`sdk-v${manifest.version}`);
  });

  it("still carries the historical records, which are supposed to name old versions", () => {
    // The reason this file's checks are section-scoped rather than a file-wide grep.
    const history = section("Release attempt history");
    expect(history).toContain("sdk-v0.1.0-beta.2");
    expect(history).toContain("sdk-v0.1.0-beta.1");
  });
});
