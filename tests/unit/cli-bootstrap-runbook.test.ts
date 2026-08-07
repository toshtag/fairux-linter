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
const runbook = readFileSync(resolve(root, "docs/maintainers/release-cli.md"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "apps/cli/package.json"), "utf8")) as {
  version: string;
};

/** Fenced `bash` blocks, so a flag is asserted where it would actually be typed. */
const bashBlocks = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
const blockContaining = (needle: string) =>
  bashBlocks.find((block) => block.includes(needle)) ?? "";

/**
 * A release version written out instead of derived.
 *
 * `0.0.0-bootstrap.0` is excluded: the placeholder is a constant of the publication contract, not a
 * release, and the bootstrap publish is the one step that must name it. The npm version pinned for
 * `npm trust list` is excluded for the same reason — it is a tool floor, not a thing being tagged.
 */
const LITERAL_RELEASE_VERSION = /v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?(?=[\s"'`,)]|\.tgz|$)/g;
const PERMITTED_LITERALS = new Set(["0.0.0-bootstrap.0", "11.15.0", "22.18.0", "24.11.0"]);

describe("the CLI beta runbook names the release this repository would produce", () => {
  it("derives the version, the tag, and the spec from the manifest", () => {
    // Not `toContain(manifest.version)`, which is what pinned this runbook to `0.1.0-beta.1` in
    // every command it holds. The SDK's runbook made the same mistake and kept telling a maintainer
    // to tag `sdk-v0.1.0-beta.2` after the bump to `beta.3` — a failing release check, and one
    // irreversible command that would not have failed.
    const identity = blockContaining("CLI_VERSION=");
    expect(identity).toContain("require('./apps/cli/package.json').version");
    expect(identity).toContain('CLI_TAG="v${CLI_VERSION}"');
    expect(identity).toContain('CLI_SPEC="fairux@${CLI_VERSION}"');
    // The tag the contract would produce is still the one the document describes.
    expect(cliReleaseTag(manifest.version)).toBe(`v${manifest.version}`);
  });

  it("names no literal release version in anything it tells you to run", () => {
    for (const block of bashBlocks) {
      for (const match of block.matchAll(LITERAL_RELEASE_VERSION)) {
        const literal = (match[0] as string).replace(/^v/, "");
        expect(PERMITTED_LITERALS, `\`${match[0]}\` is written out in a runbook command`).toContain(
          literal,
        );
      }
    }
  });

  it("tags once, annotated, and pushes the full ref", () => {
    // A lightweight tag carries no author or date, and `git push origin <name>` will match a branch
    // of the same name. Both are what the SDK runbook settled on after the same review.
    const releasing = blockContaining("git tag");
    expect(releasing).toContain('git tag -a "$CLI_TAG"');
    expect(releasing).toContain('git push origin "refs/tags/$CLI_TAG"');
    expect(bashBlocks.filter((block) => block.includes("git tag"))).toHaveLength(1);
  });

  it("names the dist-tag that version resolves to", () => {
    // Both channels are named in this runbook, because it describes a package's whole life: the
    // prerelease channel every beta publishes to, and the stable one the first `0.1.0` moves. It
    // asserted `distTag === next`, which is a fact about whichever version the manifest happened to
    // carry rather than about the document — and it failed the preparation pull request that bumped
    // to the first stable version.
    const release = resolveCliRelease(cliReleaseTag(manifest.version));
    expect([CLI_PRERELEASE_DIST_TAG, CLI_STABLE_DIST_TAG]).toContain(release.distTag);
    expect(runbook).toContain(`\`${release.distTag}\``);
    expect(runbook).toContain(`\`${CLI_PRERELEASE_DIST_TAG}\``);
    expect(runbook).toContain(`\`${CLI_STABLE_DIST_TAG}\``);
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

  it("records that latest holds the placeholder until a stable release moves it", () => {
    expect(runbook).toContain(`\`${CLI_STABLE_DIST_TAG}\``);
    expect(runbook).toContain(
      `the \`${CLI_BOOTSTRAP_VERSION}\` placeholder, until the first stable release moves it`,
    );
  });
});

describe("the bootstrap publish command", () => {
  const publish = blockContaining("npm publish");

  it("names the bootstrap dist-tag explicitly", () => {
    // Without `--tag`, the placeholder would be on `bootstrap` and nothing else would be, and the
    // name/version that lands there can never be reused afterwards. npm sets `latest` to it either
    // way — see the runbook section on why that is correct and not removable.
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
    expect(runbook).toContain("latest:    0.0.0-bootstrap.0");
  });

  it("says the placeholder on latest is correct and tells nobody to remove it", () => {
    // The instruction that used to be here — `npm dist-tag rm fairux latest`, scoped to the owner —
    // asked for something npm refuses with HTTP 400, and the preflight that enforced its outcome
    // refused the first beta over a state no owner could reach. What replaced it is the reason.
    // Whitespace-normalised: these are sentences, and where markdown wraps them is not the claim.
    const prose = runbook.replace(/\s+/g, " ");
    expect(prose).toContain("is correct, and is not something to fix");
    expect(prose).toContain("`npm dist-tag rm fairux latest` is refused with HTTP 400");
    expect(prose).toContain("npm sets `latest` on a package's first publish");
    // Named only inside the explanation of why it does not work, never as a step to run.
    const asAStep = runbook
      .split("\n")
      .filter((line) => line.trimStart().startsWith("npm dist-tag rm"));
    expect(asAStep).toEqual([]);
  });

  it("says what keeps the placeholder from being installed by accident", () => {
    // Deprecation is the whole of the answer now that removal is not one.
    expect(runbook).toContain("npm deprecate");
    expect(runbook).toContain("installs it in passing");
  });

  it("deprecates the placeholder so it is not installed in passing", () => {
    expect(blockContaining("npm deprecate")).toContain(
      `'${CLI_PACKAGE_NAME}@${CLI_BOOTSTRAP_VERSION}'`,
    );
  });

  it("states the irreversibility accurately", () => {
    // The runbook said "versions cannot be unpublished after 72 hours", which is not npm's policy:
    // an unpublish after 72 hours is *conditional* (no dependents, few recent downloads, a sole
    // owner), not impossible. What is genuinely irreversible is narrower and stronger — the exact
    // name/version can never be reused, unpublished or not — and that is the sentence a reader
    // needs before they publish a placeholder by hand.
    expect(runbook).toContain("can never be reused");
    expect(runbook).toContain("not even after an unpublish");
    expect(runbook).toContain("conditional on npm's policy criteria");
    expect(runbook).not.toContain("cannot be unpublished after 72 hours");
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
    expect(runbook).toContain("the workflow does not change it");
    expect(runbook).toContain("Update it in a separate pull request, after reading the registry");
  });

  it("records the milestones that had to land, as history rather than as a gate", () => {
    // They were pre-release checkboxes, and after the first beta they were checkboxes that could
    // never be unticked — the shape the release criteria call a permanently open row, and the one a
    // reader learns to skip. Each still has to be named, and named as landed: dropping them would
    // lose the record of what the release path was built out of.
    const record = runbook.slice(runbook.indexOf("### What had to land before the first release"));
    expect(record.length, "the milestone record is missing").toBeGreaterThan(200);
    for (const milestone of ["M1-R2", "M1-R3", "M1-R4", "M1-R5"]) {
      expect(record, milestone).toContain(milestone);
    }
    // And they are not checkboxes any more.
    for (const milestone of ["M1-R2", "M1-R3", "M1-R4", "M1-R5"]) {
      expect(runbook, milestone).not.toMatch(new RegExp(`- \\[ \\][^\n]*${milestone}`));
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
      "`latest` is not the bootstrap placeholder, absent, or an older stable release",
      "not exactly `0.0.0-bootstrap.0`",
      "the tag is gone from `origin`",
      "already published with a different digest",
    ]) {
      expect(runbook).toContain(refusal);
    }
  });

  it("states the channel rule as precedence, not as absence", () => {
    // "`next` must not exist" is true of the first beta and false of every release after it. The
    // runbook has to say the rule the workflow actually enforces, because an owner reading it
    // before `0.1.0-beta.2` needs to know that an existing `next` is normal.
    expect(runbook).toContain("A channel may advance and must not go backwards");
    expect(runbook).toContain("older than `X` by SemVer precedence");
    expect(runbook).toContain("prerelease after a stable release");
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

describe("the runbook scopes the provenance claim", () => {
  it("says what the read-back proves and what it does not", () => {
    // The release notes previously asserted provenance the workflow had never read. The runbook
    // has to keep the two claims apart, because the stronger one is M1-R4's job.
    expect(runbook).toContain("npm *reports* attestation metadata");
    expect(runbook).toContain("does not fetch the bundle or verify a signature");
    expect(runbook).toContain("npm audit signatures");
    expect(runbook).toContain("M1-R4");
  });
});

describe("the runbook scopes GitHub Release repair", () => {
  it("says repair covers notes and assets, not classification", () => {
    // "create or repair" promised more than `gh release edit` can do: it cannot clear a prerelease
    // flag, so a misclassified Release would have been reported as repaired.
    expect(runbook).toContain("notes, title, and\nassets");
    expect(runbook).toContain("does **not** reclassify one");
    expect(runbook).toContain("cannot clear a prerelease flag");
  });

  it("says a misclassified Release stops the run rather than being rewritten", () => {
    expect(runbook).toContain("stops the run — change it on GitHub and re-run");
    expect(runbook).toContain("draft or misclassified");
  });
});

/**
 * The header, which had outlived what it described.
 *
 * It read *"Nothing here has been executed. `fairux` is not on npm, no `v*` tag exists, and no
 * GitHub Release for the CLI exists."* — true when written, false from the first beta onward, and
 * sitting above a section of the same document that records two published releases. Nothing checked
 * it, so nothing said it had stopped being true.
 *
 * What replaces it is not a second copy of the publication state. The state lives in
 * `After the release`; the header points at it.
 */
describe("the runbook does not deny releases it records", () => {
  it("no longer claims the package is unpublished", () => {
    // Block quotes stripped first: the document keeps the refuted sentence as a quotation of what
    // it used to say, and a check that forbade the words would forbid the correction explaining
    // them.
    const claims = runbook
      .split("\n")
      .filter((line) => !line.trimStart().startsWith(">"))
      .join("\n");
    expect(claims).not.toContain("Nothing here has been executed");
    expect(claims).not.toContain("`fairux` is not on npm");
    // And the quotation itself is still there, so the correction keeps its evidence.
    expect(runbook).toContain("> Nothing here has been executed.");
  });

  it("sends a reader to the section that holds the measured state", () => {
    expect(runbook).toContain("[After the release](#after-the-release)");
    expect(runbook).toContain("## After the release");
  });

  it("derives the dist-tag in its own contract table rather than naming one", () => {
    // `| npm dist-tag | next |` was correct for every release the CLI had made and is the row a
    // stable release contradicts. The workflow derives it from the version; so does this table.
    const contract = runbook.slice(
      runbook.indexOf("## Publication contract"),
      runbook.indexOf("### Why `latest` holds the placeholder"),
    );
    expect(contract).toContain(`\`${CLI_STABLE_DIST_TAG}\` for a stable release`);
    expect(contract).toContain(`\`${CLI_PRERELEASE_DIST_TAG}\` for a prerelease`);
    expect(contract).not.toMatch(/^\| npm dist-tag \| `?next`? \|$/m);
  });
});
