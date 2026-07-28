import { describe, expect, it } from "vitest";
import type { NpmRegistryState } from "../scripts/npm-registry-state.d.mts";
import type {
  RegistryReadContext,
  RegistryWaitAttempt,
} from "../scripts/release-registry-wait.d.mts";
import {
  REGISTRY_WAIT_DELAYS_MS,
  REGISTRY_WAIT_FAILURES,
  REGISTRY_WAIT_MAX_ELAPSED_MS,
  RegistryWaitError,
  waitForRegistryVersion,
} from "../scripts/release-registry-wait.mjs";

/**
 * The retry added for issue #62 is only correct if it waits for exactly one thing, for no longer
 * than it says. These tests are written against a fake clock precisely so that both are checkable:
 * the attempt count, the delay sequence, and the elapsed total are asserted as values, not observed
 * as timing. Nothing here sleeps, so a 120-second deadline costs nothing to exercise.
 *
 * The clock advances on **reads** as well as sleeps. It did not in the first version of this file,
 * which is why a module bounding only its sleeps passed: with 30s reads it slept its 97s and ran for
 * 307s, and nothing failed.
 */

const SHASUM = "f89bb1c9165c9d16397534c33746e9edc8ee4bf4";
const INTEGRITY = "sha512-fixture";
const SPEC = "@fairux/sdk@0.1.0-beta.2";

const present = (
  overrides: Partial<Extract<NpmRegistryState, { status: "present" }>> = {},
): NpmRegistryState => ({
  status: "present",
  version: "0.1.0-beta.2",
  shasum: SHASUM,
  integrity: INTEGRITY,
  ...overrides,
});

const absent = (): NpmRegistryState => ({ status: "absent" });

/** A clock that only moves when the code under test spends time — sleeping or reading. */
function fakeClock(start = 1_000) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleeps,
    advance: (ms: number) => {
      current += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
  };
}

/**
 * A reader that answers from a script, records what it was told about the deadline, and charges the
 * clock for the time it takes.
 *
 * A read given less budget than it needs behaves like the real subprocess timeout: it burns what it
 * was given and throws, rather than quietly overrunning.
 */
function scriptedReader(
  responses: Array<NpmRegistryState | Error>,
  clock: ReturnType<typeof fakeClock>,
  durationMs = 0,
) {
  const contexts: RegistryReadContext[] = [];
  return {
    contexts,
    read(_spec: string, context: RegistryReadContext): NpmRegistryState {
      contexts.push({ ...context });
      const spent = Math.min(durationMs, context.remainingMs);
      clock.advance(spent);
      if (spent < durationMs) throw new Error("npm view timed out");
      const response = responses[contexts.length - 1];
      if (response === undefined) throw new Error(`unexpected read #${contexts.length}`);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function waitWith(
  responses: Array<NpmRegistryState | Error>,
  overrides: Partial<Parameters<typeof waitForRegistryVersion>[0]> = {},
  readDurationMs = 0,
) {
  const clock = fakeClock();
  const reader = scriptedReader(responses, clock, readDurationMs);
  const attempts: RegistryWaitAttempt[] = [];
  const result = waitForRegistryVersion({
    spec: SPEC,
    expectedShasum: SHASUM,
    expectedIntegrity: INTEGRITY,
    readState: reader.read,
    sleep: clock.sleep,
    now: clock.now,
    onAttempt: (attempt) => attempts.push(attempt),
    ...overrides,
  });
  return { result, clock, reader, attempts };
}

const elapsedOf = (clock: ReturnType<typeof fakeClock>) => clock.now() - 1_000;

describe("registry wait — the production schedule", () => {
  it("sleeps for at most 97s, inside a 120s deadline", () => {
    const total = REGISTRY_WAIT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(REGISTRY_WAIT_DELAYS_MS).toEqual([2_000, 5_000, 10_000, 20_000, 30_000, 30_000]);
    expect(total).toBe(97_000);
    expect(REGISTRY_WAIT_MAX_ELAPSED_MS).toBe(120_000);
    // The sleeps have to fit even before any read is paid for; the deadline covers both.
    expect(total).toBeLessThanOrEqual(REGISTRY_WAIT_MAX_ELAPSED_MS);
  });

  it("refuses a schedule whose sleeps alone exceed the deadline, before reading anything", () => {
    const { result, reader } = waitWith([absent()], { delaysMs: [60_000, 61_000] });
    expect(result).rejects.toThrow(/exceeds the 120000ms deadline/);
    expect(reader.contexts).toEqual([]);
  });
});

describe("registry wait — absent is the only state that waits", () => {
  it("returns as soon as the version appears with matching digests", async () => {
    const { result, clock, reader, attempts } = waitWith([absent(), absent(), present()]);

    await expect(result).resolves.toEqual({
      version: "0.1.0-beta.2",
      shasum: SHASUM,
      integrity: INTEGRITY,
      attempts: 3,
      elapsedMs: 7_000,
    });
    expect(reader.contexts).toHaveLength(3);
    // Exactly the leading delays of the production schedule, and nothing after the match.
    expect(clock.sleeps).toEqual([2_000, 5_000]);
    expect(attempts.map((a) => [a.attempt, a.status, a.elapsedMs, a.nextDelayMs])).toEqual([
      [1, "absent", 0, 2_000],
      [2, "absent", 2_000, 5_000],
      [3, "present", 7_000, undefined],
    ]);
  });

  it("does not sleep at all when the first read already matches", async () => {
    const { result, clock, reader } = waitWith([present()]);

    await expect(result).resolves.toMatchObject({ attempts: 1, elapsedMs: 0 });
    expect(reader.contexts).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("exhausts the schedule exactly once when reads are free", async () => {
    const { result, clock, reader } = waitWith(Array.from({ length: 7 }, absent));

    // Seven reads, six delays: the schedule is the gap *between* attempts, so an eighth read would
    // mean a delay nothing budgeted for.
    const error = await result.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RegistryWaitError);
    expect(error).toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.TIMED_OUT,
      spec: SPEC,
      attempts: 7,
      elapsedMs: 97_000,
    });
    expect((error as Error).message).toContain(SPEC);
    expect((error as Error).message).toContain("7 attempt(s)");
    expect((error as Error).message).toContain("97000ms");
    expect((error as Error).message).toContain("deadline 120000ms");
    expect((error as Error).message).toContain("schedule exhausted");
    expect(reader.contexts).toHaveLength(7);
    expect(clock.sleeps).toEqual([...REGISTRY_WAIT_DELAYS_MS]);
  });
});

describe("registry wait — the deadline covers reads, not only sleeps", () => {
  it("stops at 120s when every read takes 30s", async () => {
    // Measured against the first version of this module, which bounded only its sleeps: 7 reads,
    // 97000ms of sleep, 307000ms elapsed, reported as a success of the 120s contract.
    const { result, clock, reader } = waitWith(Array.from({ length: 7 }, absent), {}, 30_000);

    await expect(result).rejects.toMatchObject({ reason: REGISTRY_WAIT_FAILURES.TIMED_OUT });
    expect(elapsedOf(clock)).toBeLessThanOrEqual(REGISTRY_WAIT_MAX_ELAPSED_MS);
    expect(elapsedOf(clock)).toBe(120_000);
    expect(reader.contexts.length).toBeLessThan(7);
    expect(reader.contexts).toHaveLength(4);
  });

  it("tells every read how much of the deadline is left", async () => {
    const { result, reader } = waitWith(Array.from({ length: 7 }, absent), {}, 10_000);

    await expect(result).rejects.toMatchObject({ reason: REGISTRY_WAIT_FAILURES.TIMED_OUT });
    // read 1 at 0ms; then 10s read + 2s sleep, 10s + 5s, 10s + 10s, …
    expect(reader.contexts.map((c) => c.remainingMs)).toEqual([
      120_000, 108_000, 93_000, 73_000, 43_000, 3_000,
    ]);
    expect(reader.contexts.map((c) => c.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    // Every read was issued with budget left, and none was issued without.
    expect(reader.contexts.every((c) => c.remainingMs > 0)).toBe(true);
  });

  it("does not sleep when the first read consumes the entire budget", async () => {
    const { result, clock, reader } = waitWith([absent()], {}, 120_000);

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.TIMED_OUT,
      attempts: 1,
      elapsedMs: 120_000,
    });
    expect(reader.contexts).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("refuses a delay that does not fit rather than shortening it", async () => {
    // The schedule is fixed. A trimmed sleep would start a read the deadline never covered, and
    // report the shortened wait as if it were the policy.
    const { result, clock, reader } = waitWith(
      Array.from({ length: 4 }, absent),
      { delaysMs: [2_000, 2_000, 2_000], maxElapsedMs: 11_000 },
      2_000,
    );

    const error = await result.catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.TIMED_OUT,
      attempts: 3,
      elapsedMs: 10_000,
    });
    expect((error as Error).message).toContain("next delay 2000ms exceeds the remaining 1000ms");
    expect(clock.sleeps).toEqual([2_000, 2_000]);
    expect(reader.contexts).toHaveLength(3);
  });

  it("reports a read that ran out the clock as the deadline, not as a broken reader", async () => {
    const { result } = waitWith([absent()], { delaysMs: [2_000], maxElapsedMs: 10_000 }, 30_000);

    const error = await result.catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.TIMED_OUT,
      attempts: 1,
      elapsedMs: 10_000,
    });
    expect((error as Error).message).toContain("read failed at the deadline");
  });
});

describe("registry wait — every other state fails where it is observed", () => {
  it("fails on a shasum mismatch without sleeping", async () => {
    const { result, clock, reader } = waitWith([present({ shasum: "0000000000" })]);

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.SHASUM_MISMATCH,
      attempts: 1,
      elapsedMs: 0,
    });
    expect(clock.sleeps).toEqual([]);
    expect(reader.contexts).toHaveLength(1);
  });

  it("fails on an integrity mismatch without sleeping", async () => {
    const { result, clock } = waitWith([present({ integrity: "sha512-different" })]);

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.INTEGRITY_MISMATCH,
      attempts: 1,
      elapsedMs: 0,
    });
    expect(clock.sleeps).toEqual([]);
  });

  it("reports a mismatch regardless of how much deadline is left", async () => {
    // A mismatch is not a state the clock has any bearing on; it must not be reported as a timeout.
    const { result } = waitWith([present({ shasum: "0000000000" })], {
      delaysMs: [],
      maxElapsedMs: 1,
    });

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.SHASUM_MISMATCH,
    });
  });

  it("stops at a mismatch that appears mid-wait, rather than reading past it", async () => {
    const { result, clock, reader } = waitWith([
      absent(),
      present({ shasum: "0000000000" }),
      present(),
    ]);

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.SHASUM_MISMATCH,
      attempts: 2,
    });
    expect(reader.contexts).toHaveLength(2);
    expect(clock.sleeps).toEqual([2_000]);
  });

  it("fails on malformed registry metadata", async () => {
    const { result, clock } = waitWith([
      { status: "unavailable", reason: "npm view returned malformed JSON: Unexpected token" },
    ]);

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.UNAVAILABLE,
      attempts: 1,
    });
    expect(clock.sleeps).toEqual([]);
  });

  it("fails on a reader error inside the deadline rather than calling it a timeout", async () => {
    // `getNpmRegistryState` classifies E404 as `absent` itself, so a throw is the read breaking.
    const { result, clock } = waitWith([new Error("npm view failed")]);

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.READ_FAILED,
      attempts: 1,
    });
    expect(clock.sleeps).toEqual([]);
  });

  it("does not retry an unavailable state that a later read would have resolved", async () => {
    const { result, reader } = waitWith([
      { status: "unavailable", reason: "npm ERR! 500 Internal Server Error" },
      present(),
    ]);

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.UNAVAILABLE,
    });
    expect(reader.contexts).toHaveLength(1);
  });
});
