import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditSdkDistTagsAfterPublish,
  auditSdkDistTagsBeforePublish,
  auditUnchangedDistTags,
  SDK_DIST_TAG_PHASES,
  SDK_KNOWN_DIST_TAGS,
} from "../scripts/sdk-dist-tag-contract.mjs";
import { readDistTagSnapshot } from "../scripts/verify-sdk-dist-tags.mjs";

/**
 * `@fairux/sdk`'s channel layout, on both sides of `npm publish`.
 *
 * ## What replaced what
 *
 * This file used to test one audit that ran only *after* the publish. It could establish that
 * `next` named the released version and that `latest` and `bootstrap` did not — a current-value
 * check — and it hard-coded "a beta on `latest` is a publication decision nobody made".
 *
 * Two things were wrong with that once the SDK gained a stable channel. A post-publish-only audit
 * cannot refuse: an unexpected `latest` is found once the version is permanently spent, because npm
 * never lets a name/version pair be reused. And "no beta on `latest`" is a special case of a
 * general rule — `latest` carries stable releases — which is the rule that also has to *allow* the
 * one release that moves it.
 *
 * The policy is `scripts/release-channel-contract.mjs` now, shared with the CLI, and the SDK's
 * before/after snapshot comparison stays: current values cannot express "this release moved one
 * channel and nothing else", because a `latest` that moved to an unrelated release equals neither
 * the old value nor this version.
 */

const VERSION = "0.1.0-beta.3";
const BOOTSTRAP = "0.0.0-bootstrap.0";
const HEALTHY = { next: VERSION, latest: BOOTSTRAP, bootstrap: BOOTSTRAP };

describe("before publishing a prerelease", () => {
  const before = (distTags: unknown, publishNeeded = true) =>
    auditSdkDistTagsBeforePublish({ distTags, version: VERSION, distTag: "next", publishNeeded });

  it("accepts the state a package with earlier betas is in", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: "0.1.0-beta.2" })).toEqual([]);
  });

  it("refuses a next that already names this version on a first publish", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: VERSION })).toEqual([
      expect.stringContaining("which this run has not published"),
    ]);
  });

  it("refuses a next going backwards", () => {
    expect(before({ bootstrap: BOOTSTRAP, next: "0.1.0-beta.4" })).toEqual([
      expect.stringContaining("publishing would move the channel backwards"),
    ]);
  });

  it("refuses a prerelease sitting on latest", () => {
    // The old rule — "a beta reaching latest is a publication decision" — as the general one. It
    // now refuses whatever prerelease is there, not only this run's own version.
    expect(before({ bootstrap: BOOTSTRAP, latest: "0.2.0-rc.1" })).toEqual([
      expect.stringContaining("this channel carries stable releases"),
    ]);
  });

  it("accepts latest holding the placeholder, which is where npm put it", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP })).toEqual([]);
  });

  it("requires the bootstrap placeholder, exactly", () => {
    expect(before({ latest: BOOTSTRAP, next: "0.1.0-beta.2" })).toEqual([
      expect.stringContaining("bootstrap is missing"),
    ]);
    expect(before({ bootstrap: VERSION })).toEqual([
      expect.stringContaining(`not the ${BOOTSTRAP} placeholder`),
    ]);
  });

  it("names the SDK runbook, because the fix is not this workflow's to make", () => {
    const [failure] = before({ bootstrap: BOOTSTRAP, next: VERSION });
    expect(failure).toContain("docs/maintainers/release-sdk.md");
    expect(failure).toContain("does not create, move, or remove a dist-tag");
  });

  it("on a rerun, requires next to already name this version", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: VERSION }, false)).toEqual([]);
    expect(before({ bootstrap: BOOTSTRAP, next: "0.1.0-beta.2" }, false)).toEqual([
      expect.stringContaining("is already on npm"),
    ]);
  });
});

describe("before publishing a stable release", () => {
  const before = (distTags: unknown, publishNeeded = true) =>
    auditSdkDistTagsBeforePublish({ distTags, version: "0.1.0", distTag: "latest", publishNeeded });

  it("accepts the first stable release moving latest off the placeholder", () => {
    // The case the previous contract could not express at all: it refused every version that was
    // not a beta before it ever reached a channel check.
    expect(before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: "0.1.0-beta.4" })).toEqual([]);
  });

  it("leaves next alone, even when it is newer than the stable release", () => {
    // A stable release does not retract the prerelease channel, and this workflow moves no tag it
    // did not publish to.
    expect(before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: "0.2.0-beta.1" })).toEqual([]);
  });

  it("refuses latest already naming the version being published", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: "0.1.0" })).toEqual([
      expect.stringContaining("which this run has not published"),
    ]);
  });

  it("refuses latest holding a newer stable release", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: "0.2.0" })).toEqual([
      expect.stringContaining("publishing would move the channel backwards"),
    ]);
  });

  it("on a rerun, requires latest to already name it", () => {
    expect(before({ bootstrap: BOOTSTRAP, latest: "0.1.0" }, false)).toEqual([]);
    expect(before({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP }, false)).toEqual([
      expect.stringContaining("is already on npm"),
    ]);
  });
});

describe("after publishing", () => {
  const after = (distTags: unknown, version = VERSION, distTag = "next") =>
    auditSdkDistTagsAfterPublish({ distTags, version, distTag });

  it("accepts the state a correct prerelease leaves behind", () => {
    expect(after(HEALTHY)).toEqual([]);
  });

  it("refuses a channel pointing at another version", () => {
    // The rerun case this whole check exists for: every digest check passes, and
    // `npm install @fairux/sdk@next` gives a stranger.
    expect(after({ ...HEALTHY, next: "0.1.0-beta.2" })).toEqual([
      expect.stringContaining("next must point at 0.1.0-beta.3"),
    ]);
  });

  it("refuses a channel that names nothing", () => {
    const { next: _dropped, ...withoutNext } = HEALTHY;
    expect(after(withoutNext)).toEqual([
      expect.stringContaining("next must point at 0.1.0-beta.3"),
    ]);
  });

  it("refuses a prerelease that reached latest", () => {
    // What `npm install @fairux/sdk` hands someone who asked for nothing in particular.
    expect(after({ ...HEALTHY, latest: VERSION })).toEqual([
      expect.stringContaining("this channel carries stable releases"),
    ]);
  });

  it("refuses a release that took over the bootstrap tag", () => {
    // It records the name reservation and is never retired by a later release.
    expect(after({ ...HEALTHY, bootstrap: VERSION })).toEqual([
      expect.stringContaining(`not the ${BOOTSTRAP} placeholder`),
    ]);
  });

  it("requires latest for a stable release", () => {
    expect(
      after({ bootstrap: BOOTSTRAP, latest: "0.1.0", next: VERSION }, "0.1.0", "latest"),
    ).toEqual([]);
    expect(
      after({ bootstrap: BOOTSTRAP, latest: BOOTSTRAP, next: VERSION }, "0.1.0", "latest"),
    ).toHaveLength(2);
  });

  it("reports every problem at once rather than the first", () => {
    expect(after({ next: "0.1.0-beta.2", latest: VERSION, bootstrap: VERSION })).toHaveLength(3);
  });

  it("refuses a response that is not a dist-tag map", () => {
    for (const value of [null, [], "next", undefined, 42]) {
      expect(after(value), String(value)).toEqual(["dist-tags did not parse to an object"]);
    }
  });
});

/**
 * What must not have *changed*. A run that moved a tag it was never asked to move made a decision on
 * someone's behalf, and that is only visible against a prior reading.
 */
describe("tags this release was not asked to move", () => {
  const BEFORE = { next: "0.1.0-beta.2", latest: BOOTSTRAP, bootstrap: BOOTSTRAP };

  /**
   * The bypass this check exists for, named by review and reproduced before the fix.
   *
   * `bootstrap` moving to `0.1.0-beta.2` is not this version, so no current-value rule about "does
   * any tag equal the released version" reports it. The contract is "this release was allowed to
   * move `next` and nothing else", and only a before/after comparison can say that.
   */
  it("catches a tag moving somewhere that is not this version", () => {
    const after = { next: VERSION, latest: BOOTSTRAP, bootstrap: "0.1.0-beta.2" };
    const failures = auditUnchangedDistTags({ before: BEFORE, after, channel: "next" });
    expect(failures).toEqual([expect.stringContaining("dist-tag bootstrap moved")]);
  });

  it("refuses a tag that was removed", () => {
    expect(
      auditUnchangedDistTags({
        before: BEFORE,
        after: { next: VERSION, latest: BOOTSTRAP },
        channel: "next",
      }).join(" "),
    ).toContain("dist-tag bootstrap moved");
  });

  it("accepts a run that moved only its own channel", () => {
    expect(auditUnchangedDistTags({ before: BEFORE, after: HEALTHY, channel: "next" })).toEqual([]);
  });

  it("lets a stable release move latest and nothing else", () => {
    // The channel is a parameter, not the constant `next`. Fixing it at `next` would have reported
    // the one legitimate `latest` move as a violation.
    expect(
      auditUnchangedDistTags({
        before: BEFORE,
        after: { next: "0.1.0-beta.2", latest: "0.1.0", bootstrap: BOOTSTRAP },
        channel: "latest",
      }),
    ).toEqual([]);
  });

  it("refuses a `latest` that moved while a prerelease published", () => {
    expect(
      auditUnchangedDistTags({
        before: { next: "0.1.0-beta.2", latest: BOOTSTRAP },
        after: { next: VERSION, latest: "1.0.0" },
        channel: "next",
      }).join(" "),
    ).toContain("dist-tag latest moved");
  });

  it("refuses a tag that appeared", () => {
    expect(
      auditUnchangedDistTags({
        before: { next: "0.1.0-beta.2" },
        after: { next: VERSION, canary: VERSION },
        channel: "next",
      }).join(" "),
    ).toContain("dist-tag canary appeared");
  });

  it("says nothing when no before-reading was taken", () => {
    // Absence of a prior reading is not evidence of a change, and inventing one would be worse.
    // The *caller* is what refuses a missing snapshot — see `readDistTagSnapshot` below.
    expect(auditUnchangedDistTags({ before: undefined, after: HEALTHY, channel: "next" })).toEqual(
      [],
    );
  });
});

describe("input handling", () => {
  it("knows exactly three tags and two phases", () => {
    expect([...SDK_KNOWN_DIST_TAGS].sort()).toEqual(["bootstrap", "latest", "next"]);
    expect([...SDK_DIST_TAG_PHASES]).toEqual(["before-publish", "after-publish"]);
  });

  it("refuses a publishNeeded that is not a boolean", () => {
    // It arrives through `GITHUB_ENV` as text. Treating an empty or misspelled value as falsy would
    // silently run the rerun branch on a first publish.
    for (const publishNeeded of ["true", "", undefined, 1, null]) {
      expect(
        auditSdkDistTagsBeforePublish({
          distTags: { bootstrap: BOOTSTRAP },
          version: VERSION,
          distTag: "next",
          publishNeeded: publishNeeded as never,
        }),
      ).toEqual(["publishNeeded must be a boolean from the publication plan"]);
    }
  });
});

/**
 * The snapshot the comparison needs, and every way it can be unusable.
 *
 * Each of these is fail-closed on purpose: "cannot compare" must never quietly become "nothing
 * changed", which is exactly the silence this whole check was added to remove.
 */
describe("reading the pre-publish snapshot", () => {
  const withFile = <T>(contents: string | null, body: (path: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "fairux-dist-tags-"));
    try {
      const file = join(dir, "before.json");
      if (contents !== null) writeFileSync(file, contents, "utf8");
      return body(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reads a dist-tag map", () => {
    expect(withFile(JSON.stringify(HEALTHY), readDistTagSnapshot)).toEqual({ distTags: HEALTHY });
  });

  /** Narrow the union to its failure arm, failing loudly if the snapshot was somehow readable. */
  const errorOf = (result: ReturnType<typeof readDistTagSnapshot>): string => {
    if (!("error" in result)) throw new Error("expected the snapshot to be refused");
    return result.error;
  };

  it("refuses a missing file", () => {
    expect(errorOf(withFile(null, readDistTagSnapshot))).toContain("could not read");
  });

  it("refuses an empty file", () => {
    // An empty snapshot would compare as "no tags before", which reads as "nothing was removed".
    expect(errorOf(withFile("   \n", readDistTagSnapshot))).toContain("is empty");
  });

  it("refuses malformed JSON", () => {
    expect(errorOf(withFile("{ not json", readDistTagSnapshot))).toContain("is not JSON");
  });

  it("refuses JSON that is not a dist-tag map", () => {
    for (const contents of ["[]", '"next"', "42", "null"]) {
      expect(errorOf(withFile(contents, readDistTagSnapshot)), contents).toContain(
        "not a dist-tag map",
      );
    }
  });
});

/**
 * The entry point's arguments, which decide which of the two audits runs.
 *
 * Every case here exits before the first `npm view`, so none of them touches the network. That is
 * the property being relied on: a malformed invocation must be refused rather than reaching the
 * registry and being interpreted.
 *
 * `--before-file` is the interesting one. It belongs to `after-publish` — the phase that compares
 * against a reading taken before the write — and a `before-publish` run given one would be handed a
 * snapshot of a state it is standing in the middle of. Accepting and ignoring it would make the flag
 * look supported in both phases.
 */
describe("the entry point's arguments", () => {
  const entry = resolve(import.meta.dirname, "../scripts/verify-sdk-dist-tags.mjs");
  const run = (args: string[]) => {
    try {
      execFileSync(process.execPath, [entry, ...args], { stdio: "pipe" });
      return { status: 0, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer };
      return { status: failure.status ?? -1, stderr: String(failure.stderr ?? "") };
    }
  };

  it("requires a phase it knows", () => {
    for (const args of [[], ["--phase", "publish"], ["--phase", ""]]) {
      const result = run([...args, "--version", VERSION, "--dist-tag", "next"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--phase must be one of");
    }
  });

  it("requires the plan's answer before the publish, and refuses it afterwards", () => {
    const before = run(["--phase", "before-publish", "--version", VERSION, "--dist-tag", "next"]);
    expect(before.status).toBe(2);
    expect(before.stderr).toContain("--publish-needed must be true or false");

    const after = run([
      "--phase",
      "after-publish",
      "--version",
      VERSION,
      "--dist-tag",
      "next",
      "--publish-needed",
      "true",
    ]);
    expect(after.status).toBe(2);
    expect(after.stderr).toContain("applies only to --phase before-publish");
  });

  it("requires the snapshot after the publish, and refuses it before", () => {
    const after = run(["--phase", "after-publish", "--version", VERSION, "--dist-tag", "next"]);
    expect(after.status).toBe(2);
    expect(after.stderr).toContain("--before-file is required");

    const before = run([
      "--phase",
      "before-publish",
      "--version",
      VERSION,
      "--dist-tag",
      "next",
      "--publish-needed",
      "true",
      "--before-file",
      "/tmp/nope.json",
    ]);
    expect(before.status).toBe(2);
    expect(before.stderr).toContain("applies only to --phase after-publish");
  });
});
