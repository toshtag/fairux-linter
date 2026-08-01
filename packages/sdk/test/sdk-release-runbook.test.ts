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
  description: string;
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

/**
 * A section with its `### Historical evidence …` subsection removed.
 *
 * The history is supposed to name old versions — it records what happened. What must not name one is
 * the part a maintainer executes, and the two live under the same `##` heading, so "active" has to
 * mean "up to the history" rather than "the whole section".
 */
/** Markdown wraps prose at 100 columns, and a wrap is not a difference in what the text says. */
function unwrapped(text: string): string {
  return text.replace(/\s+/g, " ");
}

function activePart(heading: string): string {
  const body = section(heading);
  const historical = body.indexOf("### Historical evidence");
  return historical < 0 ? body : body.slice(0, historical);
}

/** Any literal `sdk-v<semver>` or `fairux-sdk-<semver>.tgz` written out instead of derived. */
const LITERAL_TAG = /sdk-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;
const LITERAL_TARBALL = /fairux-sdk-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz/g;
/**
 * A real published version written into a command instead of derived.
 *
 * `9.9.9` is deliberately excluded: the negative control asserts that a version the registry does
 * *not* hold makes the smoke exit 1, so it is a sentinel rather than a version, and deriving it
 * would defeat the check it belongs to.
 */
const LITERAL_VERSION =
  /@fairux\/sdk@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|EXPECTED_VERSION=(?!9\.9\.9)\d/g;

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

/**
 * The post-publish half, which had the same bug in its most consequential place.
 *
 * These commands named `0.1.0-beta.2` literally, so following the runbook after a later release
 * would have verified *the previous version* and gone green — and the description read that closes
 * [#69](https://github.com/toshtag/fairux-linter/issues/69) would never have run against the new
 * one at all.
 */
describe("the runbook verifies the version it just published", () => {
  const active = activePart("Post-Publish Verification");

  it("derives the spec from the manifest", () => {
    expect(active).toContain("packages/sdk/package.json').version");
    expect(active).toContain('SDK_SPEC="@fairux/sdk@${SDK_VERSION}"');
  });

  it("names no literal version in anything it tells you to run", () => {
    expect(active.match(LITERAL_VERSION)).toBeNull();
  });

  it("reads back the description, which is what closes #69", () => {
    // A verification step that exists only in an issue is one that gets skipped.
    expect(active).toContain('npm view "$SDK_SPEC" description');
    expect(active).toContain(manifest.description);
    expect(active).toContain("closes #69");
  });

  it("reads back the dist-tags, and says which way each must go", () => {
    expect(active).toContain("npm view @fairux/sdk dist-tags --json");
    expect(active).toContain("`dist-tags.next`");
    // `latest` must *not* move: the beta channel is opt-in, and that is easy to lose track of.
    expect(active).toMatch(/`dist-tags\.latest`.*\*\*not\*\*/);
  });

  it("promises the signature check that the smoke now actually performs", () => {
    // The Release notes and this runbook both said `npm audit signatures` "belongs to the
    // registry-installed smoke" before the SDK's smoke did it. That made the sentence a plan rather
    // than a description, which is the class of claim this repository keeps closing.
    expect(unwrapped(active)).toContain("registry signature");
  });

  it("runs the registry smoke against the derived spec", () => {
    expect(active).toContain('SDK_SPEC="$SDK_SPEC"');
    expect(active).toContain('EXPECTED_VERSION="$SDK_VERSION"');
  });

  it("keeps the beta.2 run as history, separated from the instructions", () => {
    const history = section("Post-Publish Verification");
    expect(history).toContain("### Historical evidence for 0.1.0-beta.2");
    expect(history).toContain("0.1.0-beta.2");
    // And says why it is not a template: that run predates the signature audit.
    expect(unwrapped(history)).toContain("predates the registry signature audit");
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
