import { describe, expect, it } from "vitest";
import {
  auditSdkDistTags,
  auditUnchangedDistTags,
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
    expect(auditUnchangedDistTags({ before: undefined, after: HEALTHY })).toEqual([]);
  });
});
