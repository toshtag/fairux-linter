/**
 * What `pnpm verify:full` runs, as data rather than as a shell line.
 *
 * `pnpm verify` is the fast baseline and stays that way: lint, a build-backed typecheck, the suite,
 * and the runtime-safety check. It is what you run while you work. What it does not cover is every
 * artifact this repository generates and checks in — the rule catalog, the review baseline, the
 * corpus evaluation, the risk-index calibration, the SDK surface inventory — nor the document and
 * fixture checks, nor the two package smokes. Those live in `ci.yml`, so a contributor found out
 * from a red check after pushing rather than before.
 *
 * Every entry names an **existing** `pnpm` script. Nothing here reimplements a check, so the local
 * gate and the lane CI runs cannot drift into disagreeing about what a check *does*, and
 * `tests/unit/verify-full-contract.test.ts` compares this list against `ci.yml` so they cannot
 * drift about which checks there *are*.
 *
 * Offline on purpose. Nothing here resolves a package from a registry, needs a token, or asks
 * anything about what is published: those are the release contracts, which run after a merge and
 * need ownership this gate must not require. The two pack smokes build and inspect a local tarball,
 * and the `npm publish --dry-run` inside them uploads nothing.
 *
 * The order is CI's, and it is not arbitrary. The two checks that need nothing built come first, so
 * a document naming a script that is gone fails in seconds rather than after a build. Lint runs
 * *after* the build, because a build that emits a file lint would reject is a failure the other
 * order cannot see — issue #57.
 */

/**
 * @typedef {object} VerifyFullStep
 * @property {string} script  a `pnpm` script name, run as-is
 * @property {string} why     what it covers that `pnpm verify` does not
 * @property {boolean} [inFastVerify]  also reached by `pnpm verify`, kept here so the gate is whole
 */

/** @type {readonly VerifyFullStep[]} */
export const VERIFY_FULL_STEPS = Object.freeze([
  {
    script: "check:doc-references",
    why: "documents naming a command or a repository path that no longer exists",
  },
  {
    script: "check:third-party-fixtures",
    why: "corpus pages this project did not write, and the licences that let it ship them",
  },
  { script: "build", why: "every package, because the checks below read what it emits" },
  { script: "check:build-output", why: "what the build is allowed to emit, and where" },
  {
    script: "lint",
    why: "after the build, so it judges what the build produced as well as what is checked in",
    inFastVerify: true,
  },
  {
    script: "typecheck:built",
    why: "against the build above rather than building a second time",
    inFastVerify: true,
  },
  {
    script: "check:runtime-safety",
    why: "@fairux/core and @fairux/rules staying free of Node built-ins",
    inFastVerify: true,
  },
  {
    script: "rules:reviews:check:built",
    why: "a rule change arriving with its version bump and an updated review record",
  },
  {
    script: "rules:catalog:check:built",
    why: "the checked-in rule catalog still agreeing with the built rules",
  },
  { script: "eval:corpus:check:built", why: "detection quality against the labelled corpus" },
  {
    script: "calibrate:risk-index:check:built",
    why: "the risk-index calibration, and separately its separation claim",
  },
  { script: "api:inventory:check:built", why: "a name leaving the published SDK surface" },
  { script: "test:built", why: "the whole suite, unsharded", inFastVerify: true },
  {
    script: "test:rule-pack-author-example",
    why: "the external RulePack example, built and run the way an author would",
  },
  { script: "pack:smoke", why: "the CLI tarball, packed and inspected locally" },
  { script: "pack:smoke:sdk", why: "the SDK tarball, packed and inspected locally" },
]);

/** The script names, in order. */
export function verifyFullScripts() {
  return VERIFY_FULL_STEPS.map((step) => step.script);
}
