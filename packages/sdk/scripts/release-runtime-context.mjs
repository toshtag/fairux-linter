/**
 * What publishing the SDK requires of the environment it is running in.
 *
 * The guarantee "this publishes only on an `sdk-v*` tag push" used to be asserted by searching
 * `publish-sdk.yml` for the string `"sdk-v*"`. That is not the guarantee. Measured: moving the real
 * trigger to `other-v*` and leaving `"sdk-v*"` in a comment passed, and so did putting it under a
 * `workflow_dispatch` input default. Both would have published from a manual run.
 *
 * There is no local exemption. One existed while this guarded `release-check.mjs`, which audits
 * artifacts and is meant to run on a laptop — but the guard moved to `publish-sdk.mjs`, and the
 * exemption came with it, so an empty environment published. A workstation is not a release
 * environment; nothing that reaches `npm publish` may treat "no context" as "carry on". Checking
 * the arguments locally is what `buildSdkPublishArgs` and an injected executor are for.
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

/** The GitHub context variables this reads. All of them, always. */
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

  // `=== "true"` exactly. GitHub sets this string; `"1"`, `"false"`, and an unset value are all
  // "not a GitHub Actions run", and none of them may publish.
  if (githubActions !== "true") {
    failures.push(
      `release publication requires GitHub Actions (GITHUB_ACTIONS is ${JSON.stringify(githubActions)})`,
    );
  }

  const missing = CONTEXT_KEYS.filter((key) => {
    const value = input[key];
    return typeof value !== "string" || value === "";
  });
  if (missing.length > 0) {
    // Fail closed and stop: with the ref absent there is nothing left to compare, and reporting
    // four derived mismatches would bury the one fact that matters.
    failures.push(`release runtime context is incomplete (missing ${missing.join(", ")})`);
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
