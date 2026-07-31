import { describe, expect, it } from "vitest";
import { auditCliDistTags, CLI_KNOWN_DIST_TAGS } from "../scripts/cli-dist-tag-contract.mjs";

/**
 * The channel layout `fairux`'s first release creates.
 *
 * `npm install fairux` with no tag resolves `latest`, the package has never been published, and a
 * version cannot be unpublished after 72 hours — so the first release fixes what every later user
 * gets by default. `@fairux/sdk` parks `latest` on `0.0.0-bootstrap.0`; the CLI leaves it absent
 * until the first stable release, which stops the same install from resolving a beta without also
 * advertising a placeholder.
 *
 * A `latest` that exists during a prerelease release is therefore not a state to publish alongside.
 * `npm publish --tag next` does not create it, so nobody in this repository made it deliberately.
 * The workflow stops and names the owner; it never runs `npm dist-tag rm`.
 */

const BETA = "0.1.0-beta.1";

describe("auditCliDistTags, publishing a prerelease", () => {
  it("accepts next pointing at the released version with no latest at all", () => {
    expect(auditCliDistTags({ distTags: { next: BETA }, version: BETA, distTag: "next" })).toEqual(
      [],
    );
  });

  it("accepts the bootstrap placeholder sitting alongside", () => {
    expect(
      auditCliDistTags({
        distTags: { bootstrap: "0.0.0-bootstrap.0", next: BETA },
        version: BETA,
        distTag: "next",
      }),
    ).toEqual([]);
  });

  it("refuses a latest that exists at all", () => {
    const failures = auditCliDistTags({
      distTags: { next: BETA, latest: "0.0.0-bootstrap.0" },
      version: BETA,
      distTag: "next",
    });
    expect(failures).toEqual([expect.stringContaining("latest exists")]);
    // The message has to send a reader somewhere, because the fix is not this workflow's to make.
    expect(failures[0]).toContain("docs/cli-beta-release.md");
    expect(failures[0]).toContain("does not create, move, or remove it");
  });

  it("refuses a next that names another version", () => {
    expect(
      auditCliDistTags({ distTags: { next: "0.1.0-beta.2" }, version: BETA, distTag: "next" }),
    ).toEqual([expect.stringContaining("next must point at 0.1.0-beta.1")]);
  });

  it("refuses a missing next", () => {
    expect(auditCliDistTags({ distTags: {}, version: BETA, distTag: "next" })).toEqual([
      expect.stringContaining("next must point at"),
    ]);
  });

  it("refuses a bootstrap tag that has been moved onto a real release", () => {
    expect(
      auditCliDistTags({
        distTags: { bootstrap: BETA, next: BETA },
        version: BETA,
        distTag: "next",
      }),
    ).toEqual([expect.stringContaining("not a bootstrap placeholder")]);
  });

  it("reports a tag this repository does not know about", () => {
    expect(
      auditCliDistTags({
        distTags: { next: BETA, canary: "0.1.0-beta.0" },
        version: BETA,
        distTag: "next",
      }),
    ).toEqual([expect.stringContaining("unrecognised dist-tag(s) on fairux: canary")]);
  });
});

describe("auditCliDistTags, publishing a stable release", () => {
  it("requires latest to name it", () => {
    expect(
      auditCliDistTags({ distTags: { latest: "1.0.0" }, version: "1.0.0", distTag: "latest" }),
    ).toEqual([]);
  });

  it("refuses a stable release that did not move latest", () => {
    expect(
      auditCliDistTags({
        distTags: { latest: "0.9.0", next: BETA },
        version: "1.0.0",
        distTag: "latest",
      }),
    ).toHaveLength(2);
  });

  it("leaves next alone", () => {
    // A stable release does not retract the beta channel; `next` staying where it is is correct.
    expect(
      auditCliDistTags({
        distTags: { latest: "1.0.0", next: BETA },
        version: "1.0.0",
        distTag: "latest",
      }),
    ).toEqual([]);
  });
});

describe("auditCliDistTags input handling", () => {
  it("knows exactly three tags", () => {
    expect([...CLI_KNOWN_DIST_TAGS].sort()).toEqual(["bootstrap", "latest", "next"]);
  });

  it("refuses a reading that is not an object", () => {
    for (const distTags of [null, [], "next: 0.1.0-beta.1", 42]) {
      expect(auditCliDistTags({ distTags, version: BETA, distTag: "next" })).toEqual([
        "dist-tags did not parse to an object",
      ]);
    }
  });
});
