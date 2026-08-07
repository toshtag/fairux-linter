/**
 * Wait for a just-published version to become visible on the registry — and for nothing else.
 *
 * `sdk-v0.1.0-beta.2` published successfully and the digest verification that started in the same
 * second read the version as absent, so the run was recorded as a failure while the package existed
 * on npm and the GitHub Release step never ran (run 30258382164, attempt 2). A single read is the
 * right check everywhere except immediately after a write the registry has already accepted.
 *
 * The dangerous version of this fix is a retry loop around the whole check. `absent` is the only
 * state a propagation delay can produce: a *present* version with a different shasum or integrity is
 * a different artifact under the same immutable specifier, malformed metadata is a broken read, and
 * a failed `npm view` is a failed `npm view`. Retrying any of those turns a mismatch into a wait and
 * then into a timeout, which reads as "npm was slow" rather than "the digests do not match". So the
 * absent branch is the only one that ever sleeps, and every other outcome ends the loop on its first
 * observation.
 *
 * The bound is an **absolute deadline on elapsed time**, not a sum of sleeps. The first version of
 * this module bounded the sleeps alone, which leaves the reads unbounded — and a read is where the
 * time actually goes: in production each one is a subprocess whose own timeout is not the caller's
 * to assume. A single hung read could then outlast the wait it was part of.
 *
 * So every read is issued with the remaining budget, and the loop refuses to start a read or a sleep
 * it cannot finish inside the deadline rather than trimming one to fit. The numbers — the schedule,
 * the ceiling, and what happens at each boundary — are the constants below and the cases in
 * `packages/sdk/test/release-registry-wait.test.ts`; restating them here would make an edit to the
 * schedule an edit to this paragraph.
 *
 * Nothing here knows about npm, clocks, or processes: the reader, the sleeper, and the clock are all
 * injected, so the deadline is asserted exactly rather than approximately, and the tests take no
 * real time.
 *
 * It knows nothing about a package either, which is why it moved here from `packages/sdk/scripts/`
 * when the CLI release path needed the same wait. Both release paths import it from here; what
 * binds it to one package is the reader passed in, not a per-package copy of the schedule.
 */

/**
 * The one schedule production uses: bounded backoff, as delays *between* attempts.
 *
 * How many attempts actually happen is not this array's length. Every read spends deadline too, so
 * the loop stops at whichever comes first — the schedule running out, or the budget for the next
 * read or sleep running out.
 */
export const REGISTRY_WAIT_DELAYS_MS = Object.freeze([
  2_000, 5_000, 10_000, 20_000, 30_000, 30_000,
]);

/**
 * The ceiling issue #62 fixed, covering **everything**: registry reads, sleeps, and the loop's own
 * overhead. Enforced here rather than left to reviewers of a future edit.
 */
export const REGISTRY_WAIT_MAX_ELAPSED_MS = 120_000;

/** Why the wait ended without a matching version. */
export const REGISTRY_WAIT_FAILURES = Object.freeze({
  SHASUM_MISMATCH: "shasum_mismatch",
  INTEGRITY_MISMATCH: "integrity_mismatch",
  UNAVAILABLE: "unavailable",
  READ_FAILED: "read_failed",
  TIMED_OUT: "timed_out",
});

export class RegistryWaitError extends Error {
  /**
   * @param {string} message
   * @param {{reason: string, spec: string, attempts: number, elapsedMs: number}} details
   */
  constructor(message, { reason, spec, attempts, elapsedMs }) {
    super(message);
    this.name = "RegistryWaitError";
    this.reason = reason;
    this.spec = spec;
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * @param {readonly number[]} delaysMs
 * @param {number} maxElapsedMs
 */
function validateSchedule(delaysMs, maxElapsedMs) {
  if (!Array.isArray(delaysMs)) throw new TypeError("delaysMs must be an array of milliseconds");
  for (const delay of delaysMs) {
    if (!Number.isInteger(delay) || delay < 0) {
      throw new TypeError(`delaysMs must hold non-negative integers, got ${String(delay)}`);
    }
  }
  if (!Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0) {
    throw new TypeError(`maxElapsedMs must be a positive number, got ${String(maxElapsedMs)}`);
  }
  const total = delaysMs.reduce((sum, delay) => sum + delay, 0);
  if (total > maxElapsedMs) {
    // A schedule that cannot fit even with instantaneous reads is a mistake, not a policy.
    throw new RangeError(
      `registry wait sleeps total ${total}ms, which exceeds the ${maxElapsedMs}ms deadline`,
    );
  }
}

/**
 * Read the registry until the exact version is present with the exact digests.
 *
 * @param {object} options
 * @param {string} options.spec  `@fairux/sdk@<version>` or `fairux@<version>`
 * @param {string} options.expectedShasum
 * @param {string} options.expectedIntegrity
 * @param {(spec: string, context: {attempt: number, remainingMs: number}) => unknown} options.readState
 *   returns an `NpmRegistryState`; must not run longer than `remainingMs`
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {() => number} options.now  monotonic milliseconds; only differences are used
 * @param {readonly number[]} [options.delaysMs]
 * @param {number} [options.maxElapsedMs]
 * @param {(attempt: object) => void} [options.onAttempt]
 * @returns {Promise<{version: string, shasum: string, integrity: string, attempts: number, elapsedMs: number}>}
 */
export async function waitForRegistryVersion({
  spec,
  expectedShasum,
  expectedIntegrity,
  readState,
  sleep,
  now,
  delaysMs = REGISTRY_WAIT_DELAYS_MS,
  maxElapsedMs = REGISTRY_WAIT_MAX_ELAPSED_MS,
  onAttempt,
}) {
  validateSchedule(delaysMs, maxElapsedMs);
  const started = now();
  const elapsed = () => now() - started;
  /** Whole milliseconds left. Floored, so a sub-millisecond remainder is no budget at all. */
  const remaining = () => Math.floor(maxElapsedMs - elapsed());

  let attempts = 0;
  let lastStatus;

  /** @type {(note: string) => RegistryWaitError} */
  const timedOut = (note) =>
    new RegistryWaitError(
      // Neutral: this same failure covers a read the deadline killed and a registry that never
      // answered, and "is absent from npm" was only ever true for one of them.
      `ERROR: ${spec} did not become verifiably present before the ${maxElapsedMs}ms registry deadline (${attempts} attempt(s) over ${elapsed()}ms; last observed: ${lastStatus ?? "no read completed"}; ${note})`,
      {
        reason: REGISTRY_WAIT_FAILURES.TIMED_OUT,
        spec,
        attempts,
        elapsedMs: elapsed(),
      },
    );

  for (let attempt = 1; ; attempt += 1) {
    const remainingMs = remaining();
    if (remainingMs < 1) {
      // Never start a read the deadline cannot pay for — and never round a sub-millisecond
      // remainder up into one it can.
      throw timedOut(`no budget left for attempt ${attempt}`);
    }

    let state;
    try {
      state = await readState(spec, { attempt, remainingMs });
      attempts = attempt;
    } catch (error) {
      attempts = attempt;
      // A read the caller's own timeout killed is the deadline being reached, not the reader being
      // broken. Anything else is a real failure: `npm view` classifies E404 as `absent` itself, so
      // a throw is never the package merely being missing, and an auth error or a 500 must not be
      // waited out as if it were.
      if (error?.isRegistryReadTimeout === true || remaining() < 1) {
        throw timedOut(`read did not complete within the deadline: ${error.message}`);
      }
      throw new RegistryWaitError(`ERROR: reading ${spec} from npm failed: ${error.message}`, {
        reason: REGISTRY_WAIT_FAILURES.READ_FAILED,
        spec,
        attempts,
        elapsedMs: elapsed(),
      });
    }

    // When the answer was observed, fixed before any observer runs — a slow callback must not
    // invalidate a result that did arrive in time, and must not extend one that did not.
    const observedAtMs = elapsed();
    lastStatus = state.status;

    const scheduled = attempt <= delaysMs.length ? delaysMs[attempt - 1] : undefined;
    onAttempt?.({
      attempt,
      status: state.status,
      elapsedMs: observedAtMs,
      remainingMs: Math.floor(maxElapsedMs - observedAtMs),
      nextDelayMs:
        state.status === "absent" &&
        scheduled !== undefined &&
        scheduled <= maxElapsedMs - observedAtMs
          ? scheduled
          : undefined,
    });

    if (state.status === "present") {
      // Digests first. A mismatch is a statement about the bytes, not about the clock, and must be
      // reported as a mismatch however late it arrives.
      if (state.shasum !== expectedShasum) {
        throw new RegistryWaitError(
          [
            `ERROR: ${spec} exists on npm with a different shasum.`,
            `Expected shasum: ${expectedShasum}`,
            `Registry shasum: ${state.shasum}`,
          ].join("\n"),
          {
            reason: REGISTRY_WAIT_FAILURES.SHASUM_MISMATCH,
            spec,
            attempts,
            elapsedMs: elapsed(),
          },
        );
      }
      if (state.integrity !== expectedIntegrity) {
        throw new RegistryWaitError(
          [
            `ERROR: ${spec} exists on npm with a different integrity.`,
            `Expected integrity: ${expectedIntegrity}`,
            `Registry integrity: ${state.integrity}`,
          ].join("\n"),
          {
            reason: REGISTRY_WAIT_FAILURES.INTEGRITY_MISMATCH,
            spec,
            attempts,
            elapsedMs: elapsed(),
          },
        );
      }
      // Only a match observed *by* the deadline is a success. Checking the budget before the read
      // and not after let a read that took 121s return success against a 120s deadline.
      if (observedAtMs > maxElapsedMs) {
        throw timedOut("matching version observed after the deadline");
      }
      // Success returns from inside the loop, so no sleep can follow it.
      return {
        version: state.version,
        shasum: state.shasum,
        integrity: state.integrity,
        attempts,
        elapsedMs: observedAtMs,
      };
    }

    if (state.status === "unavailable") {
      // Malformed or incomplete metadata lands here — the registry answered with something that is
      // not a version. Command failures do not: those are raised by the reader.
      throw new RegistryWaitError(
        `ERROR: npm registry state is unavailable for ${spec}: ${state.reason}`,
        {
          reason: REGISTRY_WAIT_FAILURES.UNAVAILABLE,
          spec,
          attempts,
          elapsedMs: elapsed(),
        },
      );
    }

    // Re-read the budget after the observer: a callback that logged, wrote a file, or blocked has
    // spent deadline that the pre-callback decision would have spent again.
    const budgetForDelay = remaining();
    if (budgetForDelay < 1) throw timedOut("deadline reached while reporting the attempt");
    if (scheduled === undefined) throw timedOut("schedule exhausted");
    if (scheduled > budgetForDelay) {
      // The schedule is fixed. Trimming this delay to fit would start a read the deadline was
      // never going to cover, and report the shortened wait as if it were the policy.
      throw timedOut(`next delay ${scheduled}ms exceeds the remaining ${budgetForDelay}ms`);
    }

    await sleep(scheduled);

    // A sleeper that overshot has already spent the deadline; the next read must not start.
    if (remaining() < 1) throw timedOut("deadline reached while waiting to re-read");
  }
}
