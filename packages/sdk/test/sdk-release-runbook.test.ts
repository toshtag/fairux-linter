import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SIGNATURE_AUDIT_NPM_VERSION } from "../../../scripts/npm-signature-audit.mjs";

/**
 * The runbook's *active* instructions, as a contract.
 *
 * A runbook that hard-codes the last release's version tells the next maintainer to tag something
 * already published. That is not hypothetical: after the bump to `0.1.0-beta.3` the Local Preflight
 * still ran `--tag sdk-v0.1.0-beta.2`, which fails the release check, and the Approval Boundary
 * still named the beta.2 tag — the one command in the document where being wrong is irreversible.
 *
 * The check is **section-scoped**, not a whole-file grep. Released versions and the closeout
 * evidence are supposed to name literal versions: they record what happened. A file-wide assertion
 * would have to choose between forbidding those and permitting a stale instruction, and neither is
 * the contract.
 */

const root = resolve(import.meta.dirname, "../../..");
const runbook = readFileSync(resolve(root, "docs/maintainers/release-sdk.md"), "utf8");
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
 * A section with its `### Closeout evidence …` subsection removed.
 *
 * The evidence is supposed to name the version it is about — it records what happened. What must
 * not name one is the part a maintainer executes, and the two live under the same `##` heading, so
 * "active" has to mean "up to the evidence" rather than "the whole section".
 */
/** Markdown wraps prose at 100 columns, and a wrap is not a difference in what the text says. */
function unwrapped(text: string): string {
  return text.replace(/\s+/g, " ");
}

function activePart(heading: string): string {
  const body = section(heading);
  const evidence = body.indexOf("### Closeout evidence");
  return evidence < 0 ? body : body.slice(0, evidence);
}

/**
 * The text under one `###` heading, up to the next heading at `###` or above.
 *
 * `section()` is too coarse for the checks below: the publishing instructions and the closeout
 * evidence are different subsections of the same `##`, and a contract that forbids literal versions
 * in the first would forbid them in the second, where they are the point.
 */
function subsection(heading: string): string {
  const lines = runbook.split("\n");
  const start = lines.findIndex((line) => line === `### ${heading}`);
  if (start < 0) throw new Error(`runbook has no "### ${heading}" subsection`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
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
  });

  /**
   * There must be exactly one of each, and it must be the right one.
   *
   * Presence was the old contract — `toContain('git tag "$SDK_TAG"')` — and presence cannot see a
   * second command. This section opened with a `do not run` block holding a lightweight tag, a
   * short-ref push, and a bare `npm publish`, while the correct annotated forms sat below it: three
   * copyable wrong commands, all passing a check whose name said "exactly one place". A wrong
   * command is still a command, and the one in a "do not run" block is the one nearest the top.
   */
  it("gives exactly one tag command, and it is the annotated one", () => {
    const tags = approval.match(/^git tag .*$/gm) ?? [];
    expect(tags).toEqual(['git tag -a "$SDK_TAG" -m "@fairux/sdk ${SDK_VERSION}"']);
  });

  it("gives exactly one push, and it names the full ref", () => {
    // A short ref lets a branch of the same name be what actually moves.
    const pushes = approval.match(/^git push .*$/gm) ?? [];
    expect(pushes).toEqual(['git push origin "refs/tags/$SDK_TAG"']);
  });

  it("offers no manual publish at all", () => {
    // Not "not before approval" — never. Stating it as something approval unlocks was the error:
    // a manual publish produces a version with no provenance, no dist-tag check, and no Release,
    // and npm never lets a name/version pair be reused, so there is no second attempt.
    expect(approval.match(/^\s*npm publish\b.*$/gm)).toBeNull();
    expect(unwrapped(approval)).toContain("Do not run `npm publish` manually");
  });

  it("says which process owns publication, so the gap is not left to be guessed", () => {
    const prose = unwrapped(approval);
    expect(prose).toContain("`publish-sdk.yml` workflow owns publication");
    for (const owned of [
      "dist-tag update",
      "provenance",
      "registry read-back",
      "Release creation",
    ]) {
      expect(prose, owned).toContain(owned);
    }
  });

  it("re-derives and shows the tag immediately before approval", () => {
    // A shell that has been open for an hour is not evidence about the current manifest.
    expect(approval).toContain("about to tag");
    // The same string that gets pushed: looking for one spelling and pushing another is how a
    // "must print nothing" check passes against a ref that already exists.
    expect(approval).toContain('git ls-remote --tags origin "refs/tags/$SDK_TAG"');
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

  it("pins the trust-list verifier to the same npm the signature audit uses", () => {
    // A range would let what that command reports change without anything here changing, and two
    // release-critical reads should not disagree about which npm performed them.
    const trust = runbook.match(/npx --yes npm@(\S+) trust list/);
    expect(trust?.[1]).toBe(SIGNATURE_AUDIT_NPM_VERSION);
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
});

/**
 * The one command in this document a maintainer runs against npm's own record of who may publish.
 *
 * It carried `--@fairux:registry` for as long as it existed, copied from the reads around it, where
 * pinning both keys is correct. `npm trust list` takes `--json` and `--registry` and nothing else,
 * so the documented command failed with `EUSAGE Unknown flag` for whoever ran it first. Running it
 * here is not an option — it needs browser 2FA — so the supported flag shape is pinned statically.
 */
describe("the Trusted Publisher read is a command npm will accept", () => {
  const trustCommand = (() => {
    const match = runbook.match(/npx --yes npm@[^\n]*trust list[\s\S]*?```/);
    if (!match) throw new Error("runbook has no `npm trust list` command");
    return match[0].replace(/```$/, "");
  })();

  it("uses only the flags `npm trust list` supports", () => {
    expect(trustCommand).toContain("trust list @fairux/sdk");
    expect(trustCommand).toContain("--json");
    expect(trustCommand).toContain("--registry=https://registry.npmjs.org/");
    expect(trustCommand).not.toContain("--@fairux:registry");
  });

  it("says why this one read differs from every other npm read here", () => {
    // Otherwise the next person re-adds the flag for consistency with the commands around it, which
    // is exactly how it got there.
    const reading = unwrapped(section("External Configuration Checklist"));
    expect(reading).toContain("not a flag this subcommand takes");
    expect(reading).toContain("EUSAGE");
  });

  it("still pins both registry keys for the reads that resolve a scoped package", () => {
    // The correction is scoped to `trust list`. Weakening `install`/`view`/`publish` would trade one
    // wrong command for a class of reads answered by whatever host an npmrc happens to name.
    const post = activePart("Post-Publish Verification");
    expect(post).toContain("--@fairux:registry=https://registry.npmjs.org/");
  });
});

/**
 * What the next release's instructions may not contain.
 *
 * This subsection has now carried a wrong tag command twice: `sdk-v0.1.0-beta.3`, which became an
 * instruction to tag an already-published version the moment it shipped, and then
 * `sdk-v0.1.0-beta.N`, a placeholder that copies into a literal tag by that name. The fix is not a
 * third spelling — it is having no second copy of the tag command at all, with `Approval Boundary`
 * as the one place it lives.
 */
describe("the next release's instructions point at the canonical commands", () => {
  const instructions = subsection("Preparing and publishing the next SDK beta");

  it("carries no literal or placeholder tag", () => {
    expect(instructions.match(LITERAL_TAG)).toBeNull();
    expect(instructions).not.toContain("beta.N");
    expect(instructions.match(LITERAL_VERSION)).toBeNull();
  });

  it("defers to the sections that derive the tag from the manifest", () => {
    expect(instructions).toContain("#local-preflight");
    expect(instructions).toContain("#approval-boundary");
  });

  it("states the precondition that makes a release possible at all", () => {
    // npm never lets a name/version pair be reused, so starting from the published version is not a
    // recoverable mistake — it is a run that cannot succeed.
    expect(unwrapped(instructions)).toContain(
      "cannot start from the manifest version that is already published",
    );
  });

  it("keeps the tag command itself in exactly one place, derived", () => {
    const approval = section("Approval Boundary");
    expect(approval).toContain('git tag -a "$SDK_TAG"');
    expect(approval).toContain('git push origin "refs/tags/$SDK_TAG"');
    expect(approval.match(LITERAL_TAG)).toBeNull();
  });
});

/**
 * The closeout record's internal consistency.
 *
 * A release record that both claims a verification and denies it tells a reader nothing, and the
 * denial is the half that gets quoted. This section had exactly that: "the bundle's own signature
 * chain was not verified here" sat four paragraphs above the smoke table reporting that pinned npm
 * verified the provenance attestation. The limit belongs to the workflow's metadata read-back, not
 * to the audit.
 */
describe("the closeout evidence does not contradict its own measurements", () => {
  /**
   * Every closeout record in the runbook, not the manifest version's.
   *
   * This read `Closeout evidence — ${manifest.version}`, which assumes the manifest names a version
   * npm already serves. That is false for exactly the window a release lives in: the preparation
   * pull request bumps the manifest *before* publishing, and evidence measured after the fact cannot
   * exist yet — so the check demanded a record of something that had not happened.
   *
   * Checking all of them is also stricter than checking one. A closeout written for an earlier
   * version could contradict itself for as long as nobody bumped past it.
   */
  const closeouts = [...runbook.matchAll(/^### (Closeout evidence — .+)$/gm)].map(
    (match) => [match[1] as string, unwrapped(subsection(match[1] as string))] as const,
  );

  it("has at least one closeout record to check", () => {
    // A regex that matched nothing would make every case below vacuous.
    expect(closeouts.length).toBeGreaterThan(0);
  });

  /**
   * The newest closeout record, and the version it belongs to.
   *
   * "The newest release that actually happened" — which is the manifest's version only outside the
   * window between a preparation pull request and the publish it prepares. Several checks below
   * used the manifest and so demanded evidence of something not yet done.
   */
  const [newestHeading, newestEvidence] = closeouts[0] as readonly [string, string];
  const publishedVersion = newestHeading.replace("Closeout evidence — ", "").trim();

  it("records that the attestation was verified, and by what", () => {
    for (const [heading, evidence] of closeouts) {
      expect(evidence, heading).toContain("npm audit signatures --include-attestations");
      expect(evidence, heading).toContain(
        "verified the registry signature and the provenance attestation",
      );
    }
  });

  it("does not deny the verification it just recorded", () => {
    for (const [heading, evidence] of closeouts) {
      for (const denial of [
        "signature chain was not verified",
        "no attestation verification was performed",
        "the bundle was not verified",
      ]) {
        expect(evidence, `${heading}: ${denial}`).not.toContain(denial);
      }
    }
  });

  it("separates the workflow's metadata read-back from the later audit", () => {
    for (const [heading, evidence] of closeouts) {
      expect(evidence, heading).toContain("metadata only");
      expect(evidence, heading).toContain("did not fetch the Sigstore bundle");
    }
  });

  it("names the assertion this repository did not make", () => {
    // The honest residue: the subject digest binds the attestation to the bytes, not to the build.
    expect(newestEvidence, newestHeading).toContain("source and build fields");
    // The run that published it, so the record points at something a reader can open.
    expect(newestEvidence, newestHeading).toMatch(/actions\/runs\/\d+/);
  });

  it("distinguishes the checksum record from the checksum file's own bytes", () => {
    // The file is 94 bytes of `<sha256>  <filename>`; its own digest was never measured.
    //
    // The first half of this pinned one spelling — "SHA-256 value recorded **in**" — and so failed
    // when the record was rewritten to state the equation instead, which says the same thing more
    // precisely. What matters is that the value is described as *recorded in* the file rather than
    // as the file, so either wording of that passes and neither "the file is the digest" does.
    expect(newestEvidence, newestHeading).toMatch(
      /(?:value|digest) recorded (?:\*\*in\*\*|in) `?release-sha256\.txt`?/,
    );
    expect(newestEvidence, newestHeading).toContain("Its own digest was not measured");
  });

  it("points the instructions and the verification section at that record", () => {
    // Both used the manifest's version, which is the published one only outside a release window.
    const instructions = section("What the next version bump must carry");
    expect(instructions).toContain("### Preparing and publishing the next SDK beta");
    expect(instructions).toContain(`[Closeout evidence — ${publishedVersion}]`);

    const verification = section("Post-Publish Verification");
    expect(verification).toContain(`### Closeout evidence — ${publishedVersion}`);
    expect(verification).toContain(`sdk-v${publishedVersion}`);
  });
});

describe("the runbook's version-specific sections match the manifest", () => {
  // The two cross-reference checks that used to live here moved into the closeout describe above,
  // where they are asked about the newest *published* version. They were asked about the manifest's
  // version, which during a preparation pull request names a release that has not happened.

  it("still records every version that consumed a tag, published or not", () => {
    // The reason this file's checks are section-scoped rather than a file-wide grep — and the one
    // fact a run log cannot replace: npm never lets a name/version pair be reused, so a tag burned
    // by a failed publish is burned permanently and the next release must skip it.
    const released = section("Released versions");
    expect(released).toContain("sdk-v0.1.0-beta.1");
    expect(released).toContain("never published");
    expect(released).toContain("sdk-v0.1.0-beta.2");
    expect(released).toContain(`sdk-v${manifest.version}`);
  });
});
