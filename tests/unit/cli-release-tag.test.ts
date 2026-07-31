import { describe, expect, it } from "vitest";
import {
  CliReleaseTagError,
  resolveRemoteTag,
  verifyRemoteTagCommit,
} from "../../apps/cli/scripts/release-tag-contract.mjs";

/**
 * What the release tag points at, read from `git ls-remote` rather than assumed.
 *
 * `github.sha` is the commit the tag named when the run was triggered. The privileged job waits on
 * the `publish` environment's required reviewer, so the gap since then is however long a human
 * takes — long enough for the tag to be deleted or force-moved, and nothing in the workflow used to
 * re-read it.
 *
 * The concrete failure: `gh release create <tag>` creates the tag when it is missing, from the
 * default branch's current head. A tag deleted mid-run would have produced an npm package built
 * from `TAG_COMMIT` sitting beside a GitHub Release tag pointing at `main` — one tag naming two
 * different sources.
 *
 * Annotated tags are why this is not a string comparison: `git ls-remote --tags` reports one twice,
 * as the tag object and as the commit it peels to. Comparing against the tag object would reject
 * every annotated tag.
 */

const COMMIT = "26ebbcc6f73775dff777575d9436e66356912128";
const OTHER = "3553f8cecef7095562ea5d365594a0701e1b212d";
const TAG_OBJECT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const TAG = "v0.1.0-beta.1";

const line = (sha: string, ref: string) => `${sha}\t${ref}\n`;

describe("resolveRemoteTag", () => {
  it("reads a lightweight tag from its direct ref", () => {
    expect(resolveRemoteTag({ tag: TAG, output: line(COMMIT, `refs/tags/${TAG}`) })).toEqual({
      commit: COMMIT,
      annotated: false,
    });
  });

  it("reads an annotated tag from its peeled ref, not the tag object", () => {
    const output = line(TAG_OBJECT, `refs/tags/${TAG}`) + line(COMMIT, `refs/tags/${TAG}^{}`);
    expect(resolveRemoteTag({ tag: TAG, output })).toEqual({ commit: COMMIT, annotated: true });
  });

  it("does not depend on the order git happens to print the two refs", () => {
    const output = line(COMMIT, `refs/tags/${TAG}^{}`) + line(TAG_OBJECT, `refs/tags/${TAG}`);
    expect(resolveRemoteTag({ tag: TAG, output }).commit).toBe(COMMIT);
  });

  it("refuses a tag that is not there", () => {
    expect(() => resolveRemoteTag({ tag: TAG, output: "" })).toThrow(CliReleaseTagError);
    expect(() => resolveRemoteTag({ tag: TAG, output: "" })).toThrow(/does not exist on origin/);
  });

  it("refuses output that only mentions a different tag", () => {
    // A prefix match would accept `refs/tags/v0.1.0-beta.10` for `v0.1.0-beta.1`.
    const output = line(COMMIT, "refs/tags/v0.1.0-beta.10");
    expect(() => resolveRemoteTag({ tag: TAG, output })).toThrow(/does not exist on origin/);
  });

  it("refuses a ref that resolves to more than one commit", () => {
    const output = line(COMMIT, `refs/tags/${TAG}`) + line(OTHER, `refs/tags/${TAG}`);
    expect(() => resolveRemoteTag({ tag: TAG, output })).toThrow(/more than one commit/);
  });

  it("refuses a duplicated peeled ref too", () => {
    const output =
      line(TAG_OBJECT, `refs/tags/${TAG}`) +
      line(COMMIT, `refs/tags/${TAG}^{}`) +
      line(OTHER, `refs/tags/${TAG}^{}`);
    expect(() => resolveRemoteTag({ tag: TAG, output })).toThrow(/more than one commit/);
  });

  it("tolerates the same ref repeated with the same commit", () => {
    const output = line(COMMIT, `refs/tags/${TAG}`) + line(COMMIT, `refs/tags/${TAG}`);
    expect(resolveRemoteTag({ tag: TAG, output }).commit).toBe(COMMIT);
  });

  it("refuses output it cannot read rather than skipping the line", () => {
    // Skipping would be deciding that whatever git said does not matter.
    expect(() =>
      resolveRemoteTag({ tag: TAG, output: "fatal: could not read from remote" }),
    ).toThrow(/a line this cannot read/);
    expect(() => resolveRemoteTag({ tag: TAG, output: `${COMMIT} refs/tags/${TAG}\n` })).toThrow(
      /a line this cannot read/,
    );
    expect(() => resolveRemoteTag({ tag: TAG, output: line("short", `refs/tags/${TAG}`) })).toThrow(
      /a line this cannot read/,
    );
  });

  it("ignores blank lines and unrelated refs it was not asked about", () => {
    const output = `\n${line(COMMIT, `refs/tags/${TAG}`)}${line(OTHER, "refs/heads/main")}\n`;
    expect(resolveRemoteTag({ tag: TAG, output }).commit).toBe(COMMIT);
  });

  it("refuses a missing tag argument", () => {
    expect(() => resolveRemoteTag({ tag: "", output: "" })).toThrow(/release tag is missing/);
  });

  it("treats a shell-bearing tag as data", () => {
    // Git permits `"`, `$`, `;`, and a backtick in a ref name. Nothing here builds a command line.
    const hostile = 'v0.1.0";id;"';
    const output = line(COMMIT, `refs/tags/${hostile}`);
    expect(resolveRemoteTag({ tag: hostile, output }).commit).toBe(COMMIT);
  });
});

describe("verifyRemoteTagCommit", () => {
  it("accepts a lightweight tag naming the expected commit", () => {
    expect(
      verifyRemoteTagCommit({
        tag: TAG,
        output: line(COMMIT, `refs/tags/${TAG}`),
        expectedCommit: COMMIT,
      }),
    ).toEqual({ commit: COMMIT, annotated: false });
  });

  it("accepts an annotated tag whose peeled commit is the expected one", () => {
    const output = line(TAG_OBJECT, `refs/tags/${TAG}`) + line(COMMIT, `refs/tags/${TAG}^{}`);
    expect(verifyRemoteTagCommit({ tag: TAG, output, expectedCommit: COMMIT })).toMatchObject({
      annotated: true,
    });
  });

  it("refuses a tag that was force-moved after the run started", () => {
    expect(() =>
      verifyRemoteTagCommit({
        tag: TAG,
        output: line(OTHER, `refs/tags/${TAG}`),
        expectedCommit: COMMIT,
      }),
    ).toThrow(/no longer names the commit this run is building/);
  });

  it("refuses an annotated tag whose peeled commit moved", () => {
    // The tag object's SHA is never the expected commit, so a check that compared it would pass
    // this by accident and fail every legitimate annotated tag.
    const output = line(TAG_OBJECT, `refs/tags/${TAG}`) + line(OTHER, `refs/tags/${TAG}^{}`);
    expect(() => verifyRemoteTagCommit({ tag: TAG, output, expectedCommit: COMMIT })).toThrow(
      /peeled from an annotated tag/,
    );
  });

  it("refuses a deleted tag", () => {
    expect(() => verifyRemoteTagCommit({ tag: TAG, output: "", expectedCommit: COMMIT })).toThrow(
      /does not exist on origin/,
    );
  });

  it("refuses an expected commit that is not a full SHA", () => {
    for (const expectedCommit of ["26ebbcc", "", "HEAD", COMMIT.toUpperCase()]) {
      expect(() =>
        verifyRemoteTagCommit({
          tag: TAG,
          output: line(COMMIT, `refs/tags/${TAG}`),
          expectedCommit,
        }),
      ).toThrow(/full 40-hex SHA/);
    }
  });
});
