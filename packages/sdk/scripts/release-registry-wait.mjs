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
 * Nothing here knows about npm, clocks, or processes: the reader, the sleeper, and the clock are all
 * injected, so the schedule is asserted exactly rather than approximately, and the tests take no
 * real time.
 */

/**
 * The one schedule production uses, as delays *between* attempts.
 *
 * Seven reads over 97s of sleeping. Deterministic rather than jittered: one process is waiting on
 * one specifier it just wrote, so there is no thundering herd to spread out, and a fixed schedule is
 * a schedule a test can pin.
 */
export const REGISTRY_WAIT_DELAYS_MS = Object.freeze([
  2_000, 5_000, 10_000, 20_000, 30_000, 30_000,
]);

/** The ceiling issue #62 fixed, enforced here rather than left to reviewers of a future edit. */
export const REGISTRY_WAIT_MAX_TOTAL_BUDGET_MS = 120_000;

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
 * @returns {readonly number[]}
 */
function validateSchedule(delaysMs) {
  if (!Array.isArray(delaysMs)) throw new TypeError("delaysMs must be an array of milliseconds");
  for (const delay of delaysMs) {
    if (!Number.isInteger(delay) || delay < 0) {
      throw new TypeError(`delaysMs must hold non-negative integers, got ${String(delay)}`);
    }
  }
  const total = delaysMs.reduce((sum, delay) => sum + delay, 0);
  if (total > REGISTRY_WAIT_MAX_TOTAL_BUDGET_MS) {
    throw new RangeError(
      `registry wait budget ${total}ms exceeds the ${REGISTRY_WAIT_MAX_TOTAL_BUDGET_MS}ms maximum`,
    );
  }
  return delaysMs;
}

/**
 * Read the registry until the exact version is present with the exact digests.
 *
 * @param {object} options
 * @param {string} options.spec  `@fairux/sdk@<version>`
 * @param {string} options.expectedShasum
 * @param {string} options.expectedIntegrity
 * @param {(spec: string) => unknown} options.readState  returns an `NpmRegistryState`
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {() => number} options.now  monotonic-enough milliseconds; only differences are used
 * @param {readonly number[]} [options.delaysMs]
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
  onAttempt,
}) {
  const schedule = validateSchedule(delaysMs);
  const started = now();
  const elapsed = () => now() - started;

  for (let attempt = 1; ; attempt += 1) {
    let state;
    try {
      state = await readState(spec);
    } catch (error) {
      // The reader is `npm view` in production. It classifies E404 as `absent` itself, so a throw
      // is the reader breaking, not the package being missing — there is nothing here to wait for.
      throw new RegistryWaitError(`ERROR: reading ${spec} from npm failed: ${error.message}`, {
        reason: REGISTRY_WAIT_FAILURES.READ_FAILED,
        spec,
        attempts: attempt,
        elapsedMs: elapsed(),
      });
    }

    // The next delay is decided before reporting, so the log line says what actually happens next
    // rather than what the schedule would allow.
    const nextDelayMs = attempt <= schedule.length ? schedule[attempt - 1] : undefined;
    onAttempt?.({
      attempt,
      status: state.status,
      elapsedMs: elapsed(),
      nextDelayMs: state.status === "absent" ? nextDelayMs : undefined,
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
            attempts: attempt,
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
            attempts: attempt,
            elapsedMs: elapsed(),
          },
        );
      }
      // Success returns from inside the loop, so no sleep can follow it.
      return {
        version: state.version,
        shasum: state.shasum,
        integrity: state.integrity,
        attempts: attempt,
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
          attempts: attempt,
          elapsedMs: elapsed(),
        },
      );
    }

    if (nextDelayMs === undefined) {
      throw new RegistryWaitError(
        `ERROR: ${spec} is absent from npm after publish (${attempt} attempts over ${elapsed()}ms, budget ${schedule.reduce((sum, delay) => sum + delay, 0)}ms)`,
        {
          reason: REGISTRY_WAIT_FAILURES.TIMED_OUT,
          spec,
          attempts: attempt,
          elapsedMs: elapsed(),
        },
      );
    }

    await sleep(nextDelayMs);
  }
}
