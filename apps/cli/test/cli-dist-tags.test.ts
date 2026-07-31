import { describe, expect, it } from "vitest";
import {
  auditCliDistTagsAfterPublish,
  auditCliDistTagsBeforePublish,
  CLI_DIST_TAG_PHASES,
  CLI_KNOWN_DIST_TAGS,
} from "../scripts/cli-dist-tag-contract.mjs";

/**
 * The channel layout `fairux`'s first release creates, on both sides of `npm publish`.
 *
 * `npm install fairux` with no tag resolves `latest`, the package has never been published, and a
 * version cannot be unpublished after 72 hours — so the first release fixes what every later user
 * gets by default. `@fairux/sdk` parks `latest` on `0.0.0-bootstrap.0`; the CLI leaves it absent
 * until the first stable release, which stops the same install from resolving a beta without also
 * advertising a placeholder.
 *
 * The two audits exist because the first version of this contract ran only *after* the publish. An
 * unexpected `latest` was therefore reported once `0.1.0-beta.1` had already been written to npm,
 * and npm never lets a name/version pair be reused — so "refuse to publish into an unexpected
 * channel state" was a rule the workflow stated and could not keep. The pre-publish audit is the
 * one that can still refuse.
 *
 * Neither writes. `npm publish --tag next` does not create `latest`, so a `latest` that exists is
 * not something this repository produced; the workflow stops and names the owner.
 */

const BETA = "0.1.0-beta.1";
const BOOTSTRAP = "0.0.0-bootstrap.0";

describe("before publishing a prerelease, first time", () => {
  const before = (distTags: unknown, publishNeeded = true) =>
    auditCliDistTagsBeforePublish({ distTags, version: BETA, distTag: "next", publishNeeded });

  it("accepts the exact placeholder with no other channel", () => {
    expect(before({ bootstrap: BOOTSTRAP })).toEqual([]);
  });

  it("refuses a latest that exists, before anything is written to npm", () => {
    // This is the case the whole pre-publish phase exists for.
    const failures = before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP });
    expect(failures).toEqual([expect.stringContaining("latest exists")]);
    expect(failures[0]).toContain("docs/cli-beta-release.md");
    expect(failures[0]).toContain("does not create, move, or remove it");
  });

  it("refuses a next that already exists on a first publish", () => {
    expect(before({ bootstrap: BOOTSTRAP, next: "0.1.0-beta.0" })).toEqual([
      expect.stringContaining("this run did not create that tag"),
    ]);
  });

  it("refuses a bootstrap tag pointing anywhere but the exact placeholder", () => {
    // Not "looks like a bootstrap version": the runbook creates exactly one, so a second is a fact
    // about the package's history a release run must not paper over.
    expect(before({ bootstrap: "0.0.0-bootstrap.1" })).toEqual([
      expect.stringContaining(`not the ${BOOTSTRAP} placeholder`),
    ]);
    expect(before({ bootstrap: "1.0.0-bootstrap" })).toEqual([
      expect.stringContaining(`not the ${BOOTSTRAP} placeholder`),
    ]);
  });

  it("refuses a tag this repository does not know about", () => {
    expect(before({ bootstrap: BOOTSTRAP, canary: "0.1.0-beta.0" })).toEqual([
      expect.stringContaining("unrecognised dist-tag(s) on fairux: canary"),
    ]);
  });

  it("reports every problem at once", () => {
    expect(
      before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: "0.1.0-beta.0", canary: "1.0.0" }),
    ).toHaveLength(3);
  });
});

describe("before republishing a prerelease that is already on npm", () => {
  const rerun = (distTags: unknown) =>
    auditCliDistTagsBeforePublish({
      distTags,
      version: BETA,
      distTag: "next",
      publishNeeded: false,
    });

  it("accepts next already naming this version", () => {
    // The plan has separately proved the published digest matches; the only question left is
    // whether the channel still points at it.
    expect(rerun({ bootstrap: BOOTSTRAP, next: BETA })).toEqual([]);
  });

  it("refuses next naming another version", () => {
    expect(rerun({ bootstrap: BOOTSTRAP, next: "0.1.0-beta.2" })).toEqual([
      expect.stringContaining("This workflow does not move a dist-tag"),
    ]);
  });

  it("refuses a missing next", () => {
    expect(rerun({ bootstrap: BOOTSTRAP })).toEqual([
      expect.stringContaining("rather than 0.1.0-beta.1"),
    ]);
  });

  it("still refuses latest", () => {
    expect(rerun({ bootstrap: BOOTSTRAP, next: BETA, latest: BOOTSTRAP })).toEqual([
      expect.stringContaining("latest exists"),
    ]);
  });
});

describe("before publishing a stable release", () => {
  const before = (distTags: unknown, publishNeeded = true) =>
    auditCliDistTagsBeforePublish({ distTags, version: "1.0.0", distTag: "latest", publishNeeded });

  it("accepts latest holding an older version", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: "0.9.0", next: BETA })).toEqual([]);
  });

  it("accepts a latest that does not exist yet", () => {
    expect(before({ bootstrap: BOOTSTRAP, next: BETA })).toEqual([]);
  });

  it("refuses latest already naming the version being published", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: "1.0.0" })).toEqual([
      expect.stringContaining("has not been published"),
    ]);
  });

  it("on a rerun, requires latest to already name it", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: "1.0.0" }, false)).toEqual([]);
    expect(before({ bootstrap: BOOTSTRAP, latest: "0.9.0" }, false)).toEqual([
      expect.stringContaining("is already on npm"),
    ]);
  });

  it("still requires the placeholder after a stable release", () => {
    // The placeholder is the package's name-reservation history. Retiring it would be a policy
    // decision, not something `latest` appearing does on its own.
    expect(before({ latest: "0.9.0", next: BETA })).toEqual([
      expect.stringContaining("bootstrap is missing"),
    ]);
  });
});

describe("after publishing", () => {
  const after = (distTags: unknown, version = BETA, distTag = "next") =>
    auditCliDistTagsAfterPublish({ distTags, version, distTag });

  it("accepts next naming the released version with no latest", () => {
    expect(after({ bootstrap: BOOTSTRAP, next: BETA })).toEqual([]);
  });

  it("refuses a missing or moved next", () => {
    expect(after({ bootstrap: BOOTSTRAP })).toEqual([
      expect.stringContaining("next must point at 0.1.0-beta.1"),
    ]);
    expect(after({ bootstrap: BOOTSTRAP, next: "0.1.0-beta.2" })).toEqual([
      expect.stringContaining("next must point at 0.1.0-beta.1"),
    ]);
  });

  it("refuses a latest that appeared during the publish", () => {
    expect(after({ bootstrap: BOOTSTRAP, next: BETA, latest: BOOTSTRAP })).toEqual([
      expect.stringContaining("latest exists"),
    ]);
  });

  it("requires latest for a stable release and leaves next alone", () => {
    expect(after({ bootstrap: BOOTSTRAP, latest: "1.0.0", next: BETA }, "1.0.0", "latest")).toEqual(
      [],
    );
    expect(
      after({ bootstrap: BOOTSTRAP, latest: "0.9.0", next: BETA }, "1.0.0", "latest"),
    ).toHaveLength(2);
  });

  it("applies the same registry-wide rules as the pre-publish audit", () => {
    expect(after({ next: BETA, bootstrap: "9.9.9" })).toEqual([
      expect.stringContaining(`not the ${BOOTSTRAP} placeholder`),
    ]);
    expect(after({ bootstrap: BOOTSTRAP, next: BETA, canary: "1.0.0" })).toEqual([
      expect.stringContaining("unrecognised dist-tag"),
    ]);
  });
});

describe("the bootstrap placeholder is required, in every phase", () => {
  /**
   * The first version of this contract only failed when `bootstrap` existed *and* pointed
   * somewhere unexpected, so a package whose placeholder tag had been deleted by hand passed
   * silently — in both phases — and the release proceeded. The runbook and the release report both
   * claimed exact-match enforcement, which the implementation did not do.
   */
  it("refuses a missing bootstrap before a first publish", () => {
    expect(
      auditCliDistTagsBeforePublish({
        distTags: {},
        version: BETA,
        distTag: "next",
        publishNeeded: true,
      }),
    ).toContainEqual(expect.stringContaining("bootstrap is missing"));
  });

  it("refuses a missing bootstrap on a rerun", () => {
    expect(
      auditCliDistTagsBeforePublish({
        distTags: { next: BETA },
        version: BETA,
        distTag: "next",
        publishNeeded: false,
      }),
    ).toContainEqual(expect.stringContaining("bootstrap is missing"));
  });

  it("refuses a missing bootstrap after the publish", () => {
    expect(
      auditCliDistTagsAfterPublish({ distTags: { next: BETA }, version: BETA, distTag: "next" }),
    ).toContainEqual(expect.stringContaining("bootstrap is missing"));
  });

  it("refuses a bootstrap key whose value is undefined", () => {
    // The key exists, so this is a tag pointing at nothing rather than a package with no
    // placeholder — reported as a mismatch, and reported either way.
    const failures = auditCliDistTagsAfterPublish({
      distTags: { bootstrap: undefined as unknown as string, next: BETA },
      version: BETA,
      distTag: "next",
    });
    expect(failures).toEqual([expect.stringContaining(`not the ${BOOTSTRAP} placeholder`)]);
  });

  it("names the runbook, because the fix is not this workflow's to make", () => {
    const [failure] = auditCliDistTagsAfterPublish({
      distTags: { next: BETA },
      version: BETA,
      distTag: "next",
    });
    expect(failure).toContain("docs/cli-beta-release.md");
  });
});

describe("input handling", () => {
  it("knows exactly three tags and two phases", () => {
    expect([...CLI_KNOWN_DIST_TAGS].sort()).toEqual(["bootstrap", "latest", "next"]);
    expect([...CLI_DIST_TAG_PHASES]).toEqual(["before-publish", "after-publish"]);
  });

  it("refuses a reading that is not an object", () => {
    for (const distTags of [null, [], "next: 0.1.0-beta.1", 42]) {
      expect(
        auditCliDistTagsBeforePublish({
          distTags,
          version: BETA,
          distTag: "next",
          publishNeeded: true,
        }),
      ).toEqual(["dist-tags did not parse to an object"]);
      expect(auditCliDistTagsAfterPublish({ distTags, version: BETA, distTag: "next" })).toEqual([
        "dist-tags did not parse to an object",
      ]);
    }
  });

  it("refuses a publishNeeded that is not a boolean", () => {
    // It arrives through `GITHUB_ENV` as text. Treating an empty or misspelled value as falsy
    // would silently run the rerun branch on a first publish.
    for (const publishNeeded of ["true", "", undefined, 1, null]) {
      expect(
        auditCliDistTagsBeforePublish({
          distTags: { bootstrap: BOOTSTRAP },
          version: BETA,
          distTag: "next",
          publishNeeded: publishNeeded as never,
        }),
      ).toEqual(["publishNeeded must be a boolean from the publication plan"]);
    }
  });
});
