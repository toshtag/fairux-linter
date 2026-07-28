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
 * The bound is an **absolute deadline on elapsed time**, not a sum of sleeps. Bounding the sleeps
 * alone left the reads unbounded: with a fake reader taking 30s per read, the first version of this
 * module slept its 97s and ran for 307s — and in production each `npm view` carried the release
 * helpers' own 120s subprocess timeout, so seven reads plus the schedule could have reached 937s.
 * Every read is therefore issued with the remaining budget, and the loop refuses to start a read or
 * a sleep it cannot finish inside the deadline rather than trimming one to fit.
 *
 * Nothing here knows about npm, clocks, or processes: the reader, the sleeper, and the clock are all
 * injected, so the deadline is asserted exactly rather than approximately, and the tests take no
 * real time.
 */

/**
 * The one schedule production uses, as delays *between* attempts.
 *
 * Up to seven reads, sleeping at most 97s in total — how many actually happen depends on how much
 * of the deadline the reads themselves consume.
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
 * @param {string} options.spec  `@fairux/sdk@<version>`
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
  const remaining = () => maxElapsedMs - elapsed();

  /** @type {(attempts: number, note: string) => RegistryWaitError} */
  const timedOut = (attempts, note) =>
    new RegistryWaitError(
      `ERROR: ${spec} is absent from npm after publish (${attempts} attempt(s) over ${elapsed()}ms, deadline ${maxElapsedMs}ms; ${note})`,
      {
        reason: REGISTRY_WAIT_FAILURES.TIMED_OUT,
        spec,
        attempts,
        elapsedMs: elapsed(),
      },
    );

  let attempts = 0;

  for (let attempt = 1; ; attempt += 1) {
    const remainingMs = remaining();
    if (remainingMs <= 0) {
      // Never start a read the deadline cannot pay for.
      throw timedOut(attempts, `no budget left for attempt ${attempt}`);
    }

    let state;
    try {
      state = await readState(spec, { attempt, remainingMs });
      attempts = attempt;
    } catch (error) {
      attempts = attempt;
      // A read that ran out the clock is the deadline being reached, not the reader being broken.
      // Anything earlier is a real `npm view` failure — it already classifies E404 as `absent`
      // itself, so a throw is never the package merely being missing.
      if (remaining() <= 0) {
        throw timedOut(attempts, `read failed at the deadline: ${error.message}`);
      }
      throw new RegistryWaitError(`ERROR: reading ${spec} from npm failed: ${error.message}`, {
        reason: REGISTRY_WAIT_FAILURES.READ_FAILED,
        spec,
        attempts,
        elapsedMs: elapsed(),
      });
    }

    // The next delay is decided before reporting, so the log line says what actually happens next
    // rather than what the schedule would allow.
    const scheduled = attempt <= delaysMs.length ? delaysMs[attempt - 1] : undefined;
    const affordable = scheduled !== undefined && scheduled <= remaining();
    onAttempt?.({
      attempt,
      status: state.status,
      elapsedMs: elapsed(),
      remainingMs: remaining(),
      nextDelayMs: state.status === "absent" && affordable ? scheduled : undefined,
    });

    if (state.status === "present") {
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
      // Success returns from inside the loop, so no sleep can follow it.
      return {
        version: state.version,
        shasum: state.shasum,
        integrity: state.integrity,
        attempts,
        elapsedMs: elapsed(),
      };
    }

    if (state.status === "unavailable") {
      // Malformed metadata and a registry that answered with something other than 404 both land
      // here. Neither is a version that is on its way.
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

    if (scheduled === undefined) throw timedOut(attempts, "schedule exhausted");
    if (!affordable) {
      // The schedule is fixed. Trimming this delay to fit would start a read the deadline was
      // never going to cover, and report the shortened wait as if it were the policy.
      throw timedOut(attempts, `next delay ${scheduled}ms exceeds the remaining ${remaining()}ms`);
    }

    await sleep(scheduled);
  }
}
