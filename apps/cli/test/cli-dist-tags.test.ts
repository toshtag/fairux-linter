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
 * `npm install fairux` with no tag resolves `latest`, and a published name/version can never be
 * reused afterwards — so the first release fixes what every later user gets by default. Both
 * packages sit in the same place: `latest` parked on `0.0.0-bootstrap.0` until the first stable
 * release moves it.
 *
 * This file used to assert the opposite, and the assertion was unsatisfiable. It required `latest`
 * to be **absent** before the first stable release, which npm does not permit: publishing the
 * placeholder makes it the package's default — `--tag bootstrap` does not stop the *first* version
 * becoming `latest` — and `npm dist-tag rm fairux latest` is refused with HTTP 400. The preflight
 * duly refused the first beta over a state no owner could reach. The placeholder is deprecated
 * instead, so nobody installs it in passing.
 *
 * The two audits exist because the first version of this contract ran only *after* the publish. An
 * unexpected `latest` was therefore reported once `0.1.0-beta.1` had already been written to npm,
 * and npm never lets a name/version pair be reused — so "refuse to publish into an unexpected
 * channel state" was a rule the workflow stated and could not keep. The pre-publish audit is the
 * one that can still refuse.
 *
 * Neither writes. A channel this workflow did not publish to is the owner's, and one that removed
 * or moved a tag would be rewriting registry state to make its own check pass — which is exactly
 * how the unsatisfiable rule above would have been "fixed" had repair been on the table.
 */

const BETA = "0.1.0-beta.1";
const BOOTSTRAP = "0.0.0-bootstrap.0";

describe("before publishing a prerelease, first time", () => {
  const before = (distTags: unknown, publishNeeded = true) =>
    auditCliDistTagsBeforePublish({ distTags, version: BETA, distTag: "next", publishNeeded });

  it("accepts the exact placeholder with no other channel", () => {
    expect(before({ bootstrap: BOOTSTRAP })).toEqual([]);
  });

  it("accepts a latest pointing at the placeholder, which is where npm put it", () => {
    // Required case 1, and the measured state of `fairux` today. npm sets `latest` to a package's
    // first published version whatever `--tag` says, and refuses to remove it, so this is the
    // runbook's own outcome rather than something an owner has to explain.
    expect(before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP })).toEqual([]);
  });

  it("accepts a latest that does not exist at all", () => {
    // Kept because `publish-cli.yml` is a generic release path: a package whose placeholder was
    // published differently is not this repository's to refuse over.
    expect(before({ bootstrap: BOOTSTRAP })).toEqual([]);
  });

  it("still refuses a next pointing at the placeholder", () => {
    // The asymmetry, and its reason: npm creates `latest` by itself and has never created `next`,
    // so a `next` on the placeholder is a tag somebody moved into a channel this workflow owns.
    const failures = before({ bootstrap: BOOTSTRAP, next: BOOTSTRAP });
    expect(failures).toEqual([expect.stringContaining("which is not a release")]);
    expect(failures[0]).toContain("docs/maintainers/release-cli.md");
    expect(failures[0]).toContain("does not create, move, or remove a dist-tag");
  });

  it("refuses a latest that is a prerelease", () => {
    // Required cases 3 and 4. The placeholder is the one prerelease `latest` may hold; a beta —
    // this run's own or anybody else's — is what the first stable release is for.
    expect(before({ bootstrap: BOOTSTRAP, latest: "0.1.0-beta.0" })).toEqual([
      expect.stringContaining("this channel carries stable releases"),
    ]);
    expect(before({ bootstrap: BOOTSTRAP, latest: BETA })).toEqual([
      expect.stringContaining("this channel carries stable releases"),
    ]);
    expect(before({ bootstrap: BOOTSTRAP, latest: "0.2.0-rc.1" })).toEqual([
      expect.stringContaining("this channel carries stable releases"),
    ]);
  });

  it("refuses a next already naming the version this run would publish", () => {
    // `next` naming the target while the plan says a publish is needed means the registry and the
    // channel disagree about what exists.
    expect(before({ bootstrap: BOOTSTRAP, next: BETA })).toEqual([
      expect.stringContaining("which this run has not published"),
    ]);
  });

  it("refuses a next that is newer than the version this run would publish", () => {
    expect(before({ bootstrap: BOOTSTRAP, next: "0.1.0-beta.2" })).toEqual([
      expect.stringContaining("publishing would move the channel backwards"),
    ]);
  });

  it("refuses a next that is not a version at all", () => {
    expect(before({ bootstrap: BOOTSTRAP, next: "nightly" })).toEqual([
      expect.stringContaining("which is not a version"),
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
      before({ bootstrap: "1.0.0", latest: "0.9.0-rc.1", next: "0.2.0-beta.1", canary: "1.0.0" }),
    ).toHaveLength(4);
  });
});

describe("before publishing a later prerelease", () => {
  /**
   * The first version of this contract was written for the first beta of a package that had never
   * been published, and it encoded that as a rule: `next` must not exist, `latest` must not exist.
   * The workflow it guards is a *generic* release path — the M1-R1 audit recorded that decision
   * deliberately — so those rules made every release after the first one impossible.
   *
   * The real invariant is SemVer precedence: a channel may advance, and may not go backwards.
   */
  const before = (distTags: unknown, version: string) =>
    auditCliDistTagsBeforePublish({ distTags, version, distTag: "next", publishNeeded: true });

  it("allows next to advance from an older prerelease", () => {
    expect(before({ bootstrap: BOOTSTRAP, next: "0.1.0-beta.1" }, "0.1.0-beta.2")).toEqual([]);
  });

  it("allows a prerelease after an older stable release", () => {
    expect(
      before({ bootstrap: BOOTSTRAP, latest: "0.1.0", next: "0.1.0-beta.2" }, "0.2.0-beta.1"),
    ).toEqual([]);
  });

  it("refuses next going backwards or standing still", () => {
    for (const next of ["0.1.0-beta.2", "0.1.0-beta.3", "0.2.0-beta.1"]) {
      expect(before({ bootstrap: BOOTSTRAP, next }, "0.1.0-beta.2")).toEqual([
        expect.stringContaining("next"),
      ]);
    }
  });

  it("refuses a next that is not a prerelease at all", () => {
    expect(before({ bootstrap: BOOTSTRAP, next: "0.1.0" }, "0.2.0-beta.1")).toEqual([
      expect.stringContaining("next"),
    ]);
  });

  it("refuses a latest that is not older than the prerelease being published", () => {
    // `1.0.0` outranks `1.0.0-beta.1`: publishing that beta would put an older version on a
    // channel users are already past.
    expect(before({ bootstrap: BOOTSTRAP, latest: "1.0.0" }, "1.0.0-beta.1")).toEqual([
      expect.stringContaining("latest"),
    ]);
    expect(before({ bootstrap: BOOTSTRAP, latest: "2.0.0" }, "1.0.0-beta.1")).toEqual([
      expect.stringContaining("latest"),
    ]);
  });

  it("refuses a latest that is itself another prerelease, or not a version", () => {
    // The placeholder is deliberately absent from this list — it is the pre-stable state npm
    // produces, and the case below covers it.
    for (const latest of ["0.1.0-beta.1", "not-a-version"]) {
      expect(before({ bootstrap: BOOTSTRAP, latest }, "0.2.0-beta.1")).toEqual([
        expect.stringContaining("latest"),
      ]);
    }
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
    // A rerun repairs a release that landed; it does not move a channel onto it.
    expect(rerun({ bootstrap: BOOTSTRAP, next: "0.1.0-beta.2" })).toEqual([
      expect.stringContaining("does not create, move, or remove a dist-tag"),
    ]);
  });

  it("refuses a missing next", () => {
    expect(rerun({ bootstrap: BOOTSTRAP })).toEqual([
      expect.stringContaining("rather than 0.1.0-beta.1"),
    ]);
  });

  it("accepts a latest still on the placeholder, as every beta leaves it", () => {
    // Required case 2 on a rerun: publishing a beta never moves `latest`, so it is where npm put
    // it whether this is the first attempt or the fourth.
    expect(rerun({ bootstrap: BOOTSTRAP, next: BETA, latest: BOOTSTRAP })).toEqual([]);
  });

  it("still refuses a latest that is another prerelease", () => {
    expect(rerun({ bootstrap: BOOTSTRAP, next: BETA, latest: "0.2.0-rc.1" })).toEqual([
      expect.stringContaining("this channel carries stable releases"),
    ]);
  });

  it("accepts a latest holding an older stable release", () => {
    expect(
      auditCliDistTagsBeforePublish({
        distTags: { bootstrap: BOOTSTRAP, latest: "0.1.0", next: "0.2.0-beta.1" },
        version: "0.2.0-beta.1",
        distTag: "next",
        publishNeeded: false,
      }),
    ).toEqual([]);
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
      expect.stringContaining("which this run has not published"),
    ]);
  });

  it("refuses latest holding a newer stable release", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: "2.0.0" })).toEqual([
      expect.stringContaining("publishing would move the channel backwards"),
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

  it("leaves latest on the placeholder, which publishing a beta never moves", () => {
    // Required case 2, after the write. `npm publish --tag next` touches `next` and nothing else.
    expect(after({ bootstrap: BOOTSTRAP, next: BETA, latest: BOOTSTRAP })).toEqual([]);
  });

  it("refuses a latest that moved onto a prerelease or past this one during the publish", () => {
    // The same rule as before the publish, arriving a few seconds later.
    expect(after({ bootstrap: BOOTSTRAP, next: BETA, latest: "0.2.0-rc.1" })).toEqual([
      expect.stringContaining("this channel carries stable releases"),
    ]);
    expect(after({ bootstrap: BOOTSTRAP, next: BETA, latest: "9.9.9" })).toEqual([
      expect.stringContaining("publishing would move the channel backwards"),
    ]);
  });

  it("accepts a latest holding an older stable release", () => {
    expect(
      after({ bootstrap: BOOTSTRAP, latest: "0.1.0", next: "0.2.0-beta.1" }, "0.2.0-beta.1"),
    ).toEqual([]);
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

/**
 * The channel layout over a package's whole life, as one table.
 *
 * The individual cases above each guard one rule; this reads as the policy. `latest` is on the
 * placeholder from the moment the name is reserved until the first stable release moves it, and no
 * beta in between touches it — which is what makes the placeholder's presence there a fact about
 * npm rather than a state anybody has to maintain.
 */
describe("the layout, from name reservation to the first stable release", () => {
  const beta = (distTags: Record<string, string>, version: string) =>
    auditCliDistTagsBeforePublish({ distTags, version, distTag: "next", publishNeeded: true });
  const stable = (distTags: Record<string, string>, version: string) =>
    auditCliDistTagsBeforePublish({ distTags, version, distTag: "latest", publishNeeded: true });

  it("accepts the first beta against a freshly reserved name", () => {
    expect(beta({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP }, BETA)).toEqual([]);
  });

  it("accepts a later beta while latest is still the placeholder", () => {
    expect(beta({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: BETA }, "0.1.0-beta.2")).toEqual(
      [],
    );
  });

  it("accepts the first stable release moving latest off the placeholder", () => {
    expect(
      stable({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: "0.9.0-beta.4" }, "1.0.0"),
    ).toEqual([]);
  });

  it("accepts a prerelease after that stable release, with latest left where it is", () => {
    expect(
      beta({ bootstrap: BOOTSTRAP, latest: "1.0.0", next: "1.1.0-beta.1" }, "1.1.0-beta.2"),
    ).toEqual([]);
  });

  it("refuses every way latest could hold a prerelease instead", () => {
    for (const latest of [BETA, "0.1.0-beta.2", "0.2.0-rc.1", "1.0.0-alpha.1"]) {
      expect(beta({ bootstrap: BOOTSTRAP, latest }, "0.3.0-beta.1"), latest).toEqual([
        expect.stringContaining("this channel carries stable releases"),
      ]);
    }
  });

  it("keeps the placeholder required at every step, and unmoved", () => {
    // Required case 8. The name-reservation history is not something a release retires.
    expect(beta({ latest: BOOTSTRAP }, BETA)).toEqual([
      expect.stringContaining("bootstrap is missing"),
    ]);
    expect(stable({ bootstrap: "1.0.0", latest: BOOTSTRAP }, "1.0.0")).toEqual([
      expect.stringContaining(`not the ${BOOTSTRAP} placeholder`),
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
    expect(failure).toContain("docs/maintainers/release-cli.md");
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
