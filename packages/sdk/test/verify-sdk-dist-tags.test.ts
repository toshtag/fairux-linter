import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditSdkDistTags,
  auditUnchangedDistTags,
  readDistTagSnapshot,
  SDK_BETA_CHANNEL,
} from "../scripts/verify-sdk-dist-tags.mjs";

/**
 * The gap this closes is only reachable on a rerun, which is why nothing caught it.
 *
 * `release-registry-plan.mjs` finds the version already present with a matching digest, sets
 * `PUBLISH_NEEDED=false`, and skips the publish — correctly, since npm never lets a name/version
 * pair be reused. But `next` may have moved in between, and the Release notes then tell a reader to
 * `npm install @fairux/sdk@next` for a beta that is no longer on that channel.
 *
 * Every digest check in that run passes while the one instruction a consumer actually follows is
 * wrong. A green run cannot show it; only a check of the channel itself can.
 */

const VERSION = "0.1.0-beta.3";
const HEALTHY = {
  next: VERSION,
  latest: "0.0.0-bootstrap.0",
  bootstrap: "0.0.0-bootstrap.0",
};

describe("the channel the release notes tell people to install from", () => {
  it("accepts the state a correct beta release leaves behind", () => {
    expect(auditSdkDistTags({ distTags: HEALTHY, version: VERSION })).toEqual([]);
  });

  it("refuses a channel pointing at another version", () => {
    // The rerun case: the digest checks pass, and `npm install @fairux/sdk@next` gives a stranger.
    const failures = auditSdkDistTags({
      distTags: { ...HEALTHY, next: "0.1.0-beta.2" },
      version: VERSION,
    });
    expect(failures.join(" ")).toContain("dist-tag next names");
    expect(failures.join(" ")).toContain("would give them a different version");
  });

  it("refuses a channel that names nothing", () => {
    const { next: _dropped, ...withoutNext } = HEALTHY;
    expect(auditSdkDistTags({ distTags: withoutNext, version: VERSION }).join(" ")).toContain(
      "dist-tag next names undefined",
    );
  });

  it("refuses a beta that reached `latest`", () => {
    // What `npm install @fairux/sdk` hands someone who asked for nothing in particular. Nobody
    // decided that, so nothing may do it silently.
    const failures = auditSdkDistTags({
      distTags: { ...HEALTHY, latest: VERSION },
      version: VERSION,
    });
    expect(failures.join(" ")).toContain("A beta reaching latest is a publication decision");
  });

  it("refuses a release that took over the bootstrap tag", () => {
    // It records the name reservation and is never retired by a later release.
    expect(
      auditSdkDistTags({ distTags: { ...HEALTHY, bootstrap: VERSION }, version: VERSION }).join(
        " ",
      ),
    ).toContain("never retired");
  });

  it("reports every problem at once rather than the first", () => {
    expect(
      auditSdkDistTags({
        distTags: { next: "0.1.0-beta.2", latest: VERSION, bootstrap: VERSION },
        version: VERSION,
      }),
    ).toHaveLength(3);
  });

  it("refuses a response that is not a dist-tag map", () => {
    for (const value of [null, [], "next", undefined, 42]) {
      expect(auditSdkDistTags({ distTags: value, version: VERSION }), String(value)).toEqual([
        "npm view dist-tags did not return an object",
      ]);
    }
  });

  it("publishes to the beta channel, not to latest", () => {
    expect(SDK_BETA_CHANNEL).toBe("next");
  });
});

/**
 * What must not have *changed*. A run that moved a tag it was never asked to move made a decision on
 * someone's behalf, and that is only visible against a prior reading.
 */
describe("tags this release was not asked to move", () => {
  const BEFORE = {
    next: "0.1.0-beta.2",
    latest: "0.0.0-bootstrap.0",
    bootstrap: "0.0.0-bootstrap.0",
  };

  /**
   * The bypass this check exists for, named by review and reproduced before the fix.
   *
   * `latest` and `bootstrap` moving to `0.1.0-beta.2` passes every current-value check, because
   * `0.1.0-beta.2` is not the version being released. The contract is "this release was allowed to
   * move `next` and nothing else", and only a before/after comparison can say that.
   */
  it("catches tags moving somewhere that is not this version", () => {
    const after = { next: VERSION, latest: "0.1.0-beta.2", bootstrap: "0.1.0-beta.2" };
    // Current values alone: clean.
    expect(auditSdkDistTags({ distTags: after, version: VERSION })).toEqual([]);
    // Against the before-reading: two tags moved that nobody asked to move.
    const failures = auditUnchangedDistTags({ before: BEFORE, after });
    expect(failures).toHaveLength(2);
    expect(failures.join(" ")).toContain("dist-tag latest moved");
    expect(failures.join(" ")).toContain("dist-tag bootstrap moved");
  });

  it("refuses a tag that was removed", () => {
    expect(
      auditUnchangedDistTags({
        before: BEFORE,
        after: { next: VERSION, latest: "0.0.0-bootstrap.0" },
      }).join(" "),
    ).toContain("dist-tag bootstrap moved");
  });

  it("accepts a run that moved only the beta channel", () => {
    expect(
      auditUnchangedDistTags({
        before: {
          next: "0.1.0-beta.2",
          latest: "0.0.0-bootstrap.0",
          bootstrap: "0.0.0-bootstrap.0",
        },
        after: HEALTHY,
      }),
    ).toEqual([]);
  });

  it("refuses a `latest` that moved", () => {
    expect(
      auditUnchangedDistTags({
        before: { next: "0.1.0-beta.2", latest: "0.0.0-bootstrap.0" },
        after: { next: VERSION, latest: "1.0.0" },
      }).join(" "),
    ).toContain("dist-tag latest moved");
  });

  it("refuses a tag that appeared", () => {
    expect(
      auditUnchangedDistTags({
        before: { next: "0.1.0-beta.2" },
        after: { next: VERSION, canary: VERSION },
      }).join(" "),
    ).toContain("dist-tag canary appeared");
  });

  it("says nothing when no before-reading was taken", () => {
    // Absence of a prior reading is not evidence of a change, and inventing one would be worse.
    // The *caller* is what refuses a missing snapshot — see `readDistTagSnapshot` below.
    expect(auditUnchangedDistTags({ before: undefined, after: HEALTHY })).toEqual([]);
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
