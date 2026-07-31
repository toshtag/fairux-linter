import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_BOOTSTRAP_DIST_TAG,
  CLI_BOOTSTRAP_VERSION,
  CLI_PACKAGE_NAME,
  CLI_PRERELEASE_DIST_TAG,
  CLI_STABLE_DIST_TAG,
  cliReleaseTag,
  resolveCliRelease,
} from "../../apps/cli/scripts/cli-release-contract.mjs";

/**
 * The bootstrap runbook, pinned to the contract it describes.
 *
 * The bootstrap publish is the one release step no workflow performs and no test can execute: it
 * creates the `fairux` package on npm so that a Trusted Publisher record can be configured for it
 * at all. The document is therefore the only artifact, and a document is exactly the kind of
 * artifact that drifts away from the code it describes.
 *
 * What is pinned here is the machine-checkable overlap: the version, the dist-tags, the tag the
 * release uses, and the commands whose flags decide what the registry ends up holding. The prose
 * around them is not snapshotted — a runbook a test transcribes is a runbook nobody may improve.
 */

const root = resolve(import.meta.dirname, "../..");
const runbook = readFileSync(resolve(root, "docs/cli-beta-release.md"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "apps/cli/package.json"), "utf8")) as {
  version: string;
};

/** Fenced `bash` blocks, so a flag is asserted where it would actually be typed. */
const bashBlocks = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
const blockContaining = (needle: string) =>
  bashBlocks.find((block) => block.includes(needle)) ?? "";

describe("the CLI beta runbook names the release this repository would produce", () => {
  it("names the version in the manifest and the tag that releases it", () => {
    expect(runbook).toContain(manifest.version);
    expect(runbook).toContain(cliReleaseTag(manifest.version));
  });

  it("names the dist-tag that version resolves to", () => {
    const release = resolveCliRelease(cliReleaseTag(manifest.version));
    expect(release.distTag).toBe(CLI_PRERELEASE_DIST_TAG);
    expect(runbook).toContain(`\`${CLI_PRERELEASE_DIST_TAG}\``);
  });

  it("names the placeholder version and its channel", () => {
    expect(runbook).toContain(CLI_BOOTSTRAP_VERSION);
    expect(runbook).toContain(`\`${CLI_BOOTSTRAP_DIST_TAG}\``);
  });

  it("requires the placeholder to exist, not merely to be correct when present", () => {
    // The audit only failed on a *mismatched* `bootstrap`, so a package whose placeholder tag had
    // been deleted by hand passed. The runbook's checklist is the reader-facing half of that rule.
    expect(runbook).toContain("bootstrap package exists on npm");
    expect(runbook).toContain(
      `\`${CLI_BOOTSTRAP_DIST_TAG}\` dist-tag names \`${CLI_BOOTSTRAP_VERSION}\``,
    );
  });

  it("records that latest stays absent until a stable release", () => {
    expect(runbook).toContain(`\`${CLI_STABLE_DIST_TAG}\``);
    expect(runbook).toContain("absent** until the first stable release");
  });
});

describe("the bootstrap publish command", () => {
  const publish = blockContaining("npm publish");

  it("names the bootstrap dist-tag explicitly", () => {
    // Without `--tag`, npm publishes to `latest` — the one channel this contract wants empty, and
    // a version cannot be unpublished after 72 hours.
    expect(publish).toContain(`--tag ${CLI_BOOTSTRAP_DIST_TAG}`);
    expect(publish).not.toContain(`--tag ${CLI_STABLE_DIST_TAG}`);
  });

  it("names the public registry and public access", () => {
    expect(publish).toContain("--registry=https://registry.npmjs.org/");
    expect(publish).toContain("--access public");
  });

  it("publishes a tarball, not a directory", () => {
    // The placeholder is built and inspected before it is published; publishing the directory
    // would publish whatever `npm pack` had not been asked about.
    expect(publish).toMatch(/fairux-0\.0\.0-bootstrap\.0\.tgz/);
  });

  it("says the placeholder is built outside this repository", () => {
    // Bumping `apps/cli/package.json` to pack it would make the CLI's own manifest carry a version
    // the release workflow refuses.
    expect(runbook).toContain("Do not change `apps/cli/package.json`");
  });
});

describe("the runbook tells the owner to read the registry back", () => {
  it("reads the exact version's digests", () => {
    const read = blockContaining("dist.integrity");
    expect(read).toContain(`npm view ${CLI_PACKAGE_NAME}@${CLI_BOOTSTRAP_VERSION}`);
    expect(read).toContain("dist.shasum");
    expect(read).toContain("--registry=https://registry.npmjs.org/");
  });

  it("reads the dist-tags and states what they must be", () => {
    expect(blockContaining("dist-tags")).toContain(`npm view ${CLI_PACKAGE_NAME} dist-tags`);
    expect(runbook).toContain("latest:    absent");
  });

  it("scopes the only dist-tag removal to the owner, after they confirm why it is there", () => {
    // The workflow never removes one. This is the single documented exception, and it is a manual
    // step with a stated precondition rather than an automated repair.
    expect(runbook).toContain("npm dist-tag rm fairux latest");
    expect(runbook).toContain("after\nconfirming why it is there");
  });

  it("deprecates the placeholder so it is not installed in passing", () => {
    expect(blockContaining("npm deprecate")).toContain(
      `'${CLI_PACKAGE_NAME}@${CLI_BOOTSTRAP_VERSION}'`,
    );
  });

  it("states that a version cannot be unpublished after 72 hours", () => {
    expect(runbook).toContain("cannot be unpublished after 72 hours");
  });
});

describe("the runbook keeps the release path honest", () => {
  it("says the workflow refuses a bootstrap version", () => {
    expect(runbook).toContain("refuses a bootstrap version");
    expect(() => resolveCliRelease(cliReleaseTag(CLI_BOOTSTRAP_VERSION))).toThrow();
  });

  it("names the rehearsal commands that exist", () => {
    const scripts = (
      JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    for (const script of ["release:check:cli", "release:dry-run:cli"]) {
      expect(runbook).toContain(script);
      expect(scripts).toHaveProperty(script);
    }
  });

  it("keeps the docs update after the release, in a separate change", () => {
    // A release workflow that committed to the repository would be writing the claim it is
    // supposed to be evidence for.
    expect(runbook).toContain("the workflow does not\nchange them");
    expect(runbook).toContain("Update them in a separate pull request, after reading the registry");
  });

  it("lists the milestones that must land first", () => {
    for (const milestone of ["M1-R2", "M1-R3", "M1-R4", "M1-R5"]) {
      expect(runbook).toContain(milestone);
    }
  });
});

describe("the runbook states what the workflow refuses", () => {
  /**
   * The three pre-publish gates exist because npm never lets a name/version pair be reused. A
   * runbook that only described the happy path would leave an owner reading a red run with no idea
   * whether the version had been consumed.
   */
  it("says the pre-publish checks run before anything is written", () => {
    expect(runbook).toContain("without\nconsuming the version");
    expect(runbook).toContain("Checked before the publish");
  });

  it("names each thing that stops the release", () => {
    for (const refusal of [
      "`latest` exists",
      "not exactly `0.0.0-bootstrap.0`",
      "the tag is gone from `origin`",
      "already published with a different digest",
    ]) {
      expect(runbook).toContain(refusal);
    }
  });

  it("says the workflow repairs none of it", () => {
    expect(runbook).toContain("creates, moves, and removes no dist-tag");
    expect(runbook).toContain("--verify-tag");
    expect(runbook).toContain("only ever\nattached to a tag that already exists");
  });

  it("bounds what a rerun can recover, rather than promising full repair", () => {
    // "Any past release can be fully repaired from any state" is exactly the claim this must not
    // make: the rerun path works while `next` still names the version and the digest still matches.
    expect(runbook).toContain("not a general repair mechanism");
    expect(runbook).toContain("Outside that, the run stops and asks");
  });
});
