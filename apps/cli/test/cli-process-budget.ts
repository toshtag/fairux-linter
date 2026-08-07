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
 * steps before the suite and then runs the whole suite across every available fork, the same two tests
 * were measured at 10409–17354ms. Process startup is not a cost the test controls; it scales with
 * how many other forks are competing. A wall-clock budget of 10 seconds over eight to ten serial
 * `node` starts is a budget that holds on an idle machine and not on a busy one, which is what a
 * completion gate must not be.
 *
 * ## What holds now
 *
 * **The hang detector fires first.** `CLI_SPAWN_TIMEOUT_MS` is what a single CLI process gets, and
 * `CLI_PROCESS_BUDGET_MS` — the per-test budget for a file that launches it — is strictly larger. So
 * a CLI that hangs is killed by `spawnSync` and reported as the failed command it is, and the test
 * timeout is left as the backstop it should have been.
 *
 * **The global stays at 10 seconds.** Raising it for the whole repository would hide the boundary
 * for every test that launches nothing, which is the thing to avoid: the budget below is paid
 * only by the files that pay for process startup.
 *
 * **The set is read, not listed.** Which files get the budget is decided from each file's own
 * source, at the moment vitest is about to run it. There was a frozen list of twenty-six paths here,
 * kept honest by a test that derived the same set and compared — which is a second copy plus an
 * alarm, and the alarm fires after someone has already written a CLI test that ran on the wrong
 * budget. `tests/unit/cli-process-budget.test.ts` asserts the ordering, the global, and that every
 * launch in every file the predicate finds carries the detector.
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
 * The per-test budget for a file that launches the CLI.
 *
 * A policy ceiling, not a calculation. It used to be `CLI_SPAWN_TIMEOUT_MS` plus an allowance times
 * `MAX_CLI_LAUNCHES_PER_TEST = 10`, and that ten was a measurement of one test on one day — the
 * comment named which test held the record and which was second. Both facts went stale the moment
 * anyone added an assertion, and neither changed what the budget is for. A test that launches
 * eleven processes does not want a budget 3 seconds larger; it wants the same answer to "how long
 * before we stop waiting".
 *
 * The one property that has to hold is the ordering: this is larger than `CLI_SPAWN_TIMEOUT_MS`, so
 * a hung CLI is killed by `spawnSync` and reported as the command it is, rather than by a test
 * timeout that says nothing about what hung. `tests/unit/cli-process-budget.test.ts` holds that.
 */
export const CLI_PROCESS_BUDGET_MS = 50_000;

/**
 * Whether a test file's source starts the built CLI as a process.
 *
 * Both halves are needed, and each rules out a real file. `apps/cli/test/cli-source-map-audit.test.ts`
 * spawns `tar`, and `tests/unit/build-output-contract.test.ts` spawns `git`: they launch a process,
 * but not this one, and neither pays for a CLI start. The `.map` exclusion is for the same audit
 * file, which mentions `package/dist/index.js.map` as a path it looks for inside the tarball.
 *
 * This is what the setup file asks about the file it is about to run, and what the contract test
 * asks about every tracked test file. One predicate, so the budget a file gets and the detectors it
 * is required to carry are decided by the same question.
 */
export function launchesTheCli(source: string): boolean {
  return (
    /(?:spawnSync|execFileSync)\(\s*"node"/.test(source) &&
    /(?:apps\/cli\/)?dist\/index\.js(?!\.map)/.test(source)
  );
}
