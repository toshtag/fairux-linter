/**
 * What the SDK release check requires of the environment it is running in.
 *
 * The guarantee "this publishes only on an `sdk-v*` tag push" used to be asserted by searching
 * `publish-sdk.yml` for the string `"sdk-v*"`. That is not the guarantee. Measured: moving the real
 * trigger to `other-v*` and leaving `"sdk-v*"` in a comment passed, and so did putting it under a
 * `workflow_dispatch` input default. Both would have published from a manual run.
 *
 * The trigger is a *runtime* fact, so it is checked at runtime, from the context GitHub sets — the
 * event, the ref type, and the ref itself. A workflow that publishes from a branch, from a manual
 * dispatch, or from a tag naming another version fails here regardless of what its YAML says, and
 * regardless of whether any test ran on the tagged commit. (None does: `ci.yml` triggers on pushes
 * to `main` and on pull requests, so a tag push runs no test suite at all. That is exactly why this
 * cannot live only in a unit test — the workflow's *shape* is pinned by one, and its *behaviour* is
 * pinned here.)
 *
 * Node built-ins only. This runs in the publish job, which installs no dependencies.
 */

/** The GitHub context variables this reads. Present together or absent together. */
const CONTEXT_KEYS = ["eventName", "ref", "refName", "refType"];

/**
 * Violations of the release runtime contract, as a list of strings.
 *
 * Pure: every input is passed in, nothing is read from `process.env` here.
 *
 * @param {{
 *   githubActions?: string | undefined,
 *   eventName?: string | undefined,
 *   ref?: string | undefined,
 *   refName?: string | undefined,
 *   refType?: string | undefined,
 *   expectedTag: string,
 * }} input
 * @returns {string[]}
 */
export function validateSdkReleaseRuntimeContext(input) {
  const failures = [];
  const { githubActions, expectedTag } = input;

  if (typeof expectedTag !== "string" || expectedTag === "") {
    return ["release runtime context: no expected tag was supplied"];
  }

  const present = CONTEXT_KEYS.filter((key) => {
    const value = input[key];
    return typeof value === "string" && value !== "";
  });

  // A local run — `pnpm release:check:sdk` on a maintainer's machine — has none of this, and is
  // allowed to check everything else. `GITHUB_ACTIONS` alone is not treated as "in CI": what makes
  // the check meaningful is the event and the ref, so those are what must be there.
  if (githubActions !== "true" && present.length === 0) return [];

  // Partial context is a broken environment, not a local run. Failing closed here is the point:
  // a job that lost `GITHUB_REF` would otherwise take the local path and skip the whole contract.
  if (present.length !== CONTEXT_KEYS.length) {
    const missing = CONTEXT_KEYS.filter((key) => !present.includes(key));
    failures.push(
      `release runtime context is incomplete (missing ${missing.join(", ")}); refusing to treat a partial GitHub Actions environment as a local run`,
    );
    return failures;
  }

  const { eventName, ref, refName, refType } = input;

  if (eventName !== "push") {
    failures.push(`release runs on a push event only, not ${eventName}`);
  }
  if (refType !== "tag") {
    failures.push(`release runs on a tag only, not a ${refType}`);
  }
  // The full ref, not just the name: `refs/heads/sdk-v0.1.0-beta.3` is a branch whose `refName`
  // reads exactly like the tag.
  if (ref !== `refs/tags/${expectedTag}`) {
    failures.push(`release ref is ${ref}, expected refs/tags/${expectedTag}`);
  }
  if (refName !== expectedTag) {
    failures.push(`release ref name is ${refName}, expected ${expectedTag}`);
  }

  return failures;
}

/**
 * The same contract, read from a process environment.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} expectedTag
 * @returns {string[]}
 */
export function validateSdkReleaseRuntimeContextFromEnv(env, expectedTag) {
  return validateSdkReleaseRuntimeContext({
    githubActions: env.GITHUB_ACTIONS,
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    refName: env.GITHUB_REF_NAME,
    refType: env.GITHUB_REF_TYPE,
    expectedTag,
  });
}
