/**
 * Two timeouts for the tests that run the CLI as a real process, and the reason they are ordered.
 *
 * ## What was wrong
 *
 * `vitest.config.ts` sets a global `testTimeout: 10_000`, and the CLI tests gave their own
 * `spawnSync` calls timeouts of 10000, 15000, 20000, and 30000 — four numbers, spelled in the files
 * that used them. Everything above 10000 was unreachable: vitest killed the *test* first, so a
 * genuinely hung CLI was reported as `Test timed out in 10000ms` rather than by the detector written
 * for it, and no `spawnSync` timeout above the global one ever fired.
 *
 * The same ordering made `pnpm verify:full` non-deterministic. Measured on an idle machine, running
 * one file at a time:
 *
 *     leaves each flag alone when it is the only one given      1315ms   (8 CLI launches)
 *     refuses anything that is not a bare, scannable file name  1219ms  (10 CLI launches)
 *
 * — roughly 130–165ms per launch. Inside `verify:full`, which runs a full `build` and ten other
 * steps before the suite and then runs 3,800 tests across every available fork, the same two tests
 * were measured at 10409–17354ms. Process startup is not a cost the test controls; it scales with
 * how many other forks are competing. A wall-clock budget of 10 seconds over eight to ten serial
 * `node` starts is a budget that holds on an idle machine and not on a busy one, which is what a
 * completion gate must not be.
 *
 * ## What holds now
 *
 * **The hang detector fires first.** `CLI_SPAWN_TIMEOUT_MS` is what a single CLI process gets, and
 * `CLI_PROCESS_BUDGET_MS` — the per-test budget for the files listed below — is strictly larger. So
 * a CLI that hangs is killed by `spawnSync` and reported as the failed command it is, and the test
 * timeout is left as the backstop it should have been.
 *
 * **The global stays at 10 seconds.** Raising it for the whole repository would hide the boundary
 * for the ~3,700 tests that launch nothing, which is the thing to avoid: the budget below is paid
 * only by the files that pay for process startup.
 *
 * **It is derived, not chosen.** The budget is the hang detector plus an allowance per launch, and
 * the allowance is stated rather than folded into one number. `tests/unit/cli-process-budget.test.ts`
 * asserts the ordering, the global, and that this list is exactly the set of test files that launch
 * the CLI — so a new one cannot quietly inherit the 10-second budget.
 */

/**
 * How long one CLI process may run before `spawnSync` kills it.
 *
 * This is the hang detector, and it is the only number a test file passes to `spawnSync`. It
 * replaces four: 10000 and `10_000` in six files, 15000 in two, 20000 in fourteen, and 30000 in
 * three. Whatever the right value is, it is not four different values chosen a file at a time — and
 * the three files that were at 30000 are the ones whose tests launch the most processes, which is
 * the opposite of what a per-process limit should track.
 */
export const CLI_SPAWN_TIMEOUT_MS = 20_000;

/**
 * The most CLI processes any single test in these files launches.
 *
 * `refuses anything that is not a bare, scannable file name` is the current holder, at ten: one run
 * per rejected `--stdin-filename`, and the CLI exits on the first bad argument, so they cannot be
 * batched into one run. `leaves each flag alone when it is the only one given` is next, at eight —
 * four commands times two flags.
 */
export const MAX_CLI_LAUNCHES_PER_TEST = 10;

/**
 * What one launch is allowed to cost when the machine is busy.
 *
 * Twenty times the ~150ms an idle single-file run measures. That is not a prediction; it is the
 * point past which the slowness is worth failing over rather than waiting through.
 */
export const CLI_LAUNCH_ALLOWANCE_MS = 3_000;

/**
 * The per-test budget for a file that launches the CLI.
 *
 * One hang detector's worth of time, plus an allowance for every launch a test may make. It is
 * larger than `CLI_SPAWN_TIMEOUT_MS` by construction, which is the property that matters: a hung
 * CLI is reported by the detector, not by a test timeout that says nothing about what hung.
 */
export const CLI_PROCESS_BUDGET_MS =
  CLI_SPAWN_TIMEOUT_MS + MAX_CLI_LAUNCHES_PER_TEST * CLI_LAUNCH_ALLOWANCE_MS;

/**
 * Every test file that launches the built CLI, repository-relative.
 *
 * A list rather than a glob, because "launches a process" is not a fact about a directory:
 * `apps/cli/test/cli-source-map-audit.test.ts` spawns `tar` and
 * `tests/unit/build-output-contract.test.ts` spawns `git`, and neither pays for a CLI start. The
 * contract test derives the real set by reading the files and compares it against this one, so the
 * list is checked rather than trusted.
 */
export const CLI_PROCESS_TEST_FILES: readonly string[] = Object.freeze([
  "apps/cli/test/baseline.test.ts",
  "apps/cli/test/built-in-remediation.test.ts",
  "apps/cli/test/cli-contract-consistency.test.ts",
  "apps/cli/test/cli-scan-targets.test.ts",
  "apps/cli/test/cli-security.test.ts",
  "apps/cli/test/config.test.ts",
  "apps/cli/test/explain-rule.test.ts",
  "apps/cli/test/external-filter-provenance.test.ts",
  "apps/cli/test/filter-file-order.test.ts",
  "apps/cli/test/fix-write.test.ts",
  "apps/cli/test/fix.test.ts",
  "apps/cli/test/ignore-file.test.ts",
  "apps/cli/test/inline-suppression.test.ts",
  "apps/cli/test/list-rules.test.ts",
  "apps/cli/test/load-rule-pack.test.ts",
  "apps/cli/test/output-collision.test.ts",
  "apps/cli/test/report-envelope-integrity.test.ts",
  "apps/cli/test/risk-index-model.test.ts",
  "apps/cli/test/risk-index.test.ts",
  "apps/cli/test/scan-journey.test.ts",
  "apps/cli/test/scan-options.test.ts",
  "apps/cli/test/suppress-with-baseline.test.ts",
  "apps/cli/test/suppressions.test.ts",
  "apps/cli/test/version.test.ts",
  "tests/unit/cli-release-notes.test.ts",
  "tests/unit/roadmap-claims.test.ts",
]);
