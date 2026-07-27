import { describe, expect, it } from "vitest";
import type { NpmRegistryState } from "../scripts/npm-registry-state.d.mts";
import type { RegistryWaitAttempt } from "../scripts/release-registry-wait.d.mts";
import {
  REGISTRY_WAIT_DELAYS_MS,
  REGISTRY_WAIT_FAILURES,
  REGISTRY_WAIT_MAX_TOTAL_BUDGET_MS,
  RegistryWaitError,
  waitForRegistryVersion,
} from "../scripts/release-registry-wait.mjs";

/**
 * The retry added for issue #62 is only correct if it waits for exactly one thing. These tests are
 * written against a fake clock precisely so that "exactly one thing" is checkable: the attempt
 * count, the delay sequence, and the elapsed total are all asserted as values, not observed as
 * timing. Nothing here sleeps, so the always-absent case — a real 97-second wait — costs nothing.
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

/**
 * A clock that only moves when the code under test sleeps. Any elapsed time an assertion sees is
 * therefore time the schedule asked for, and never wall-clock noise.
 */
function fakeClock(start = 1_000) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
  };
}

/** A reader that answers from a script and records how many times it was asked. */
function scriptedReader(responses: Array<NpmRegistryState | Error>) {
  const specs: string[] = [];
  return {
    specs,
    read(spec: string): NpmRegistryState {
      specs.push(spec);
      const response = responses[specs.length - 1];
      if (response === undefined) throw new Error(`unexpected read #${specs.length}`);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function waitWith(
  responses: Array<NpmRegistryState | Error>,
  overrides: Partial<Parameters<typeof waitForRegistryVersion>[0]> = {},
) {
  const clock = fakeClock();
  const reader = scriptedReader(responses);
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

describe("registry wait — the production schedule", () => {
  it("stays inside the budget issue #62 fixed", () => {
    const total = REGISTRY_WAIT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(REGISTRY_WAIT_DELAYS_MS).toEqual([2_000, 5_000, 10_000, 20_000, 30_000, 30_000]);
    expect(total).toBe(97_000);
    expect(REGISTRY_WAIT_MAX_TOTAL_BUDGET_MS).toBe(120_000);
    expect(total).toBeLessThanOrEqual(REGISTRY_WAIT_MAX_TOTAL_BUDGET_MS);
  });

  it("refuses a schedule that exceeds the budget, before reading anything", async () => {
    // The ceiling lives in the module, not in a reviewer's memory: raising it takes editing the
    // constant, which is what this asserts against.
    const { result, reader } = waitWith([absent()], { delaysMs: [60_000, 61_000] });
    await expect(result).rejects.toThrow(/exceeds the 120000ms maximum/);
    expect(reader.specs).toEqual([]);
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
    expect(reader.specs).toEqual([SPEC, SPEC, SPEC]);
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
    expect(reader.specs).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("exhausts the schedule exactly once and then reports spec, attempts, and elapsed", async () => {
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
    expect((error as Error).message).toContain("7 attempts");
    expect((error as Error).message).toContain("97000ms");
    expect(reader.specs).toHaveLength(7);
    expect(clock.sleeps).toEqual([...REGISTRY_WAIT_DELAYS_MS]);
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
    expect(reader.specs).toHaveLength(1);
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

  it("stops at a mismatch that appears mid-wait, rather than reading past it", async () => {
    // The regression this guards is subtle: a loop that treats "not yet matching" as "not yet
    // present" would keep reading, and a genuine digest mismatch would surface as a timeout.
    const { result, clock, reader } = waitWith([
      absent(),
      present({ shasum: "0000000000" }),
      present(),
    ]);

    await expect(result).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.SHASUM_MISMATCH,
      attempts: 2,
    });
    expect(reader.specs).toHaveLength(2);
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

  it("fails on a reader error rather than treating it as a missing version", async () => {
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
    expect(reader.specs).toHaveLength(1);
  });
});
