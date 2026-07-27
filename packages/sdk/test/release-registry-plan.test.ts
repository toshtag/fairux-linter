import { describe, expect, it } from "vitest";
import type { NpmRegistryState } from "../scripts/npm-registry-state.d.mts";
import {
  parseRegistryPlanArgs,
  RegistryPlanUsageError,
  runRegistryPlan,
} from "../scripts/release-registry-plan.mjs";

/**
 * One script answers two questions from opposite sides of `npm publish`, and the difference between
 * them is entirely in its arguments. These assertions fix that difference: what the pre-publish
 * plan may not ask for, what the post-publish verification must, and that the pre-publish read stays
 * a single read no matter how long the registry takes.
 */

const SHASUM = "f89bb1c9165c9d16397534c33746e9edc8ee4bf4";
const INTEGRITY = "sha512-fixture";
const SPEC = "@fairux/sdk@0.1.0-beta.2";

const REQUIRED = ["--spec", SPEC, "--shasum", SHASUM, "--integrity", INTEGRITY];

const present = (
  overrides: Partial<Extract<NpmRegistryState, { status: "present" }>> = {},
): NpmRegistryState => ({
  status: "present",
  version: "0.1.0-beta.2",
  shasum: SHASUM,
  integrity: INTEGRITY,
  ...overrides,
});

function harness(responses: NpmRegistryState[]) {
  const reads: string[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let current = 0;
  return {
    reads,
    sleeps,
    logs,
    options: {
      spec: SPEC,
      expectedShasum: SHASUM,
      expectedIntegrity: INTEGRITY,
      readState: (spec: string) => {
        reads.push(spec);
        const response = responses[reads.length - 1];
        if (response === undefined) throw new Error(`unexpected read #${reads.length}`);
        return response;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
        current += ms;
      },
      now: () => current,
      log: (message: string) => logs.push(message),
    },
  };
}

describe("registry plan arguments", () => {
  it("rejects the wait without the presence requirement", () => {
    // Absence before a publish is the expected answer, and the publish about to run is what fixes
    // it. Waiting there would spend the whole budget on a state the next step resolves.
    expect(() => parseRegistryPlanArgs([...REQUIRED, "--wait-for-present"])).toThrow(
      RegistryPlanUsageError,
    );
    expect(() => parseRegistryPlanArgs([...REQUIRED, "--wait-for-present"])).toThrow(
      /--wait-for-present requires --require-present/,
    );
  });

  it("accepts the post-publish pairing", () => {
    expect(parseRegistryPlanArgs([...REQUIRED, "--require-present", "--wait-for-present"])).toEqual(
      {
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        envFile: undefined,
        requirePresent: true,
        waitForPresent: true,
      },
    );
  });

  it("leaves the pre-publish plan in neither mode", () => {
    const parsed = parseRegistryPlanArgs([...REQUIRED, "--env-file", "/tmp/env"]);
    expect(parsed.requirePresent).toBe(false);
    expect(parsed.waitForPresent).toBe(false);
    expect(parsed.envFile).toBe("/tmp/env");
  });

  it("requires the spec and both digests", () => {
    for (const argv of [
      ["--shasum", SHASUM, "--integrity", INTEGRITY],
      ["--spec", SPEC, "--integrity", INTEGRITY],
      ["--spec", SPEC, "--shasum", SHASUM],
    ]) {
      expect(() => parseRegistryPlanArgs(argv)).toThrow(RegistryPlanUsageError);
    }
  });
});

describe("pre-publish plan — one read, whatever the answer", () => {
  it("reports an absent version as a publish that is needed", async () => {
    const { options, reads, sleeps } = harness([{ status: "absent" }]);

    await expect(runRegistryPlan(options)).resolves.toEqual({
      publishNeeded: true,
      status: "absent",
    });
    expect(reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("skips a publish whose digests already match", async () => {
    const { options, reads } = harness([present()]);

    await expect(runRegistryPlan(options)).resolves.toEqual({
      publishNeeded: false,
      status: "present",
    });
    expect(reads).toHaveLength(1);
  });

  it("refuses a version that exists with different bytes", async () => {
    const { options } = harness([present({ shasum: "0000000000" })]);

    await expect(runRegistryPlan(options)).rejects.toThrow(/exists on npm with a different digest/);
  });

  it("refuses an unavailable registry rather than assuming absence", async () => {
    const { options } = harness([{ status: "unavailable", reason: "npm ERR! 500" }]);

    await expect(runRegistryPlan(options)).rejects.toThrow(/registry state is unavailable/);
  });
});

describe("post-publish verification — absence is a failure worth waiting on", () => {
  it("keeps the single-read failure when the wait is not requested", async () => {
    // `--require-present` alone is still one read. The message is the one issue #62 quotes.
    const { options, reads, sleeps } = harness([{ status: "absent" }]);

    await expect(runRegistryPlan({ ...options, requirePresent: true })).rejects.toThrow(
      `ERROR: ${SPEC} is absent from npm after publish`,
    );
    expect(reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("re-reads an absent version and succeeds when it appears", async () => {
    const { options, reads, sleeps, logs } = harness([
      { status: "absent" },
      { status: "absent" },
      present(),
    ]);

    await expect(
      runRegistryPlan({ ...options, requirePresent: true, waitForPresent: true }),
    ).resolves.toEqual({ publishNeeded: false, status: "present" });
    expect(reads).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 5_000]);
    // Each attempt is reported with its elapsed time and the delay actually taken next, so a run
    // log shows how long the registry took rather than only that it eventually answered.
    expect(logs[0]).toBe(`attempt 1: ${SPEC} is absent after 0ms; retrying in 2000ms`);
    expect(logs[1]).toBe(`attempt 2: ${SPEC} is absent after 2000ms; retrying in 5000ms`);
    expect(logs.at(-1)).toContain("present on npm with matching digest after 3 attempt(s), 7000ms");
  });

  it("does not wait out a digest mismatch", async () => {
    const { options, reads, sleeps } = harness([present({ integrity: "sha512-different" })]);

    await expect(
      runRegistryPlan({ ...options, requirePresent: true, waitForPresent: true }),
    ).rejects.toThrow(/exists on npm with a different integrity/);
    expect(reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("gives up inside the budget and says so", async () => {
    const { options, sleeps } = harness(Array.from({ length: 7 }, () => ({ status: "absent" })));

    await expect(
      runRegistryPlan({ ...options, requirePresent: true, waitForPresent: true }),
    ).rejects.toThrow(
      /is absent from npm after publish \(7 attempts over 97000ms, budget 97000ms\)/,
    );
    expect(sleeps.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(120_000);
  });
});
