import { describe, expect, it } from "vitest";
import {
  validateSdkReleaseRuntimeContext,
  validateSdkReleaseRuntimeContextFromEnv,
  // @ts-expect-error — the release scripts are plain JS, like every other one here.
} from "../scripts/release-runtime-context.mjs";

/**
 * Which invocations of the SDK release check are a release.
 *
 * "This publishes only on an `sdk-v*` tag push" was asserted by searching `publish-sdk.yml` for the
 * string `"sdk-v*"`. Measured against the real workflow: moving the trigger to `other-v*` and
 * leaving `"sdk-v*"` in a comment passed, and so did putting it under a `workflow_dispatch` input
 * default. Either would have published from a manual run.
 *
 * The trigger is a fact about the invocation, so it is read from the invocation. A unit test over
 * the YAML pins the workflow's *shape* — `publish-sdk-contract` does that — but it cannot run at
 * release time: `ci.yml` triggers on pushes to `main` and on pull requests, so a tag push runs no
 * test suite at all. This is the half that is present when it matters.
 *
 * There is no local exemption. One existed while this guarded `release-check.mjs`, which audits
 * artifacts on a laptop; it came along when the guard moved to `publish-sdk.mjs`, and an empty
 * environment could publish. Absent context is not "a maintainer checking something" — it is
 * simply not a release environment.
 */

const TAG = "sdk-v0.1.0-beta.3";

/** A well-formed tag push. */
const release = (over: Record<string, string | undefined> = {}) => ({
  githubActions: "true",
  eventName: "push",
  ref: `refs/tags/${TAG}`,
  refName: TAG,
  refType: "tag",
  expectedTag: TAG,
  ...over,
});

describe("what counts as an SDK release run", () => {
  it("accepts the tag push the workflow is for", () => {
    expect(validateSdkReleaseRuntimeContext(release())).toEqual([]);
  });

  it("is the only thing it accepts — an empty environment is not a release", () => {
    const failures = validateSdkReleaseRuntimeContext({ expectedTag: TAG });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toMatch(/requires GitHub Actions/);
  });
});

describe("what it refuses", () => {
  it.each([
    ["no GITHUB_ACTIONS at all", { githubActions: undefined }, /requires GitHub Actions/],
    ["GITHUB_ACTIONS=false", { githubActions: "false" }, /requires GitHub Actions/],
    ["GITHUB_ACTIONS=1", { githubActions: "1" }, /requires GitHub Actions/],
    ["GITHUB_ACTIONS=TRUE", { githubActions: "TRUE" }, /requires GitHub Actions/],
    ["a manual dispatch", { eventName: "workflow_dispatch" }, /push event only/],
    ["a pull request", { eventName: "pull_request" }, /push event only/],
    ["a branch, however it is named", { refType: "branch" }, /tag only/],
    [
      "a branch whose name reads like the tag",
      { refType: "branch", ref: `refs/heads/${TAG}` },
      /tag only|expected refs\/tags/,
    ],
    ["another project's tag", { ref: "refs/tags/other-v1", refName: "other-v1" }, /expected/],
    [
      "a tag for a different version",
      { ref: "refs/tags/sdk-v9.9.9", refName: "sdk-v9.9.9" },
      /expected/,
    ],
    // The name alone is not the ref: `refs/heads/sdk-v…` has a `refName` identical to the tag's.
    ["a ref that disagrees with its name", { ref: `refs/heads/${TAG}` }, /expected refs\/tags/],
  ])("refuses %s", (_name, over, expected) => {
    const failures = validateSdkReleaseRuntimeContext(release(over));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toMatch(expected);
  });

  it.each(["eventName", "ref", "refName", "refType"])(
    "refuses a GitHub environment missing %s",
    (key) => {
      // Fail-closed on purpose: a job that lost one variable would otherwise take the local path
      // and skip this contract entirely.
      const failures = validateSdkReleaseRuntimeContext(release({ [key]: undefined }));
      expect(failures.join("\n")).toMatch(/incomplete/);
    },
  );

  it("refuses GITHUB_ACTIONS=true with no event or ref at all", () => {
    const failures = validateSdkReleaseRuntimeContext({
      githubActions: "true",
      expectedTag: TAG,
    });
    expect(failures.join("\n")).toMatch(/incomplete/);
  });

  it("refuses a full, correct context that did not come from GitHub Actions", () => {
    // Someone exporting the five variables on a workstation is the case this closes.
    const failures = validateSdkReleaseRuntimeContext(release({ githubActions: undefined }));
    expect(failures.join("\n")).toMatch(/requires GitHub Actions/);
  });

  it("refuses an empty expected tag", () => {
    expect(validateSdkReleaseRuntimeContext({ ...release(), expectedTag: "" })).toEqual([
      "release runtime context: no expected tag was supplied",
    ]);
  });
});

describe("reading it from a process environment", () => {
  it("maps the GitHub variables onto the contract", () => {
    expect(
      validateSdkReleaseRuntimeContextFromEnv(
        {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: `refs/tags/${TAG}`,
          GITHUB_REF_NAME: TAG,
          GITHUB_REF_TYPE: "tag",
        },
        TAG,
      ),
    ).toEqual([]);
  });

  it("refuses a dispatch read from the environment", () => {
    const failures = validateSdkReleaseRuntimeContextFromEnv(
      {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: `refs/tags/${TAG}`,
        GITHUB_REF_NAME: TAG,
        GITHUB_REF_TYPE: "tag",
      },
      TAG,
    );
    expect(failures.join("\n")).toMatch(/push event only/);
  });

  it("refuses an empty environment", () => {
    expect(validateSdkReleaseRuntimeContextFromEnv({}, TAG).length).toBeGreaterThan(0);
  });
});
