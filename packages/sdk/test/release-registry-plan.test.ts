import { describe, expect, it } from "vitest";
import type { NpmRegistryState } from "../scripts/npm-registry-state.d.mts";
import { getNpmRegistryState } from "../scripts/npm-registry-state.mjs";
import {
  createRegistryReader,
  parseRegistryPlanArgs,
  RegistryPlanUsageError,
  runRegistryPlan,
} from "../scripts/release-registry-plan.mjs";
import {
  REGISTRY_WAIT_FAILURES,
  waitForRegistryVersion,
} from "../scripts/release-registry-wait.mjs";

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
    clock: () => current,
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
    expect(logs[0]).toBe(
      `attempt 1: ${SPEC} is absent after 0ms, 120000ms left; retrying in 2000ms`,
    );
    expect(logs[1]).toBe(
      `attempt 2: ${SPEC} is absent after 2000ms, 118000ms left; retrying in 5000ms`,
    );
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

  it("gives up inside the deadline and says so", async () => {
    const { options, sleeps, clock } = harness(
      Array.from({ length: 7 }, () => ({ status: "absent" })),
    );

    await expect(
      runRegistryPlan({ ...options, requirePresent: true, waitForPresent: true }),
    ).rejects.toThrow(
      /did not become verifiably present before the 120000ms registry deadline \(7 attempt\(s\) over 97000ms; last observed: absent; schedule exhausted\)/,
    );
    expect(sleeps.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(120_000);
    expect(clock()).toBeLessThanOrEqual(120_000);
  });

  it("refuses the wait mode programmatically, not only on the command line", async () => {
    // The CLI rejects the pairing; a caller reaching `runRegistryPlan` directly must hit the same
    // rule, or the two entry points disagree about what "post-publish" means. The declaration
    // rejects it too, which is why this is cast — the runtime guard has to hold for JavaScript
    // callers and for anyone who casts their way past the types, as this line does.
    const { options } = harness([present()]);

    await expect(runRegistryPlan({ ...options, waitForPresent: true } as never)).rejects.toThrow(
      RegistryPlanUsageError,
    );
  });
});

describe("production registry reader", () => {
  const runOf = (cacheRoot: string) => {
    const calls: Array<{ args: string[]; timeout: unknown; cache: unknown }> = [];
    const reader = createRegistryReader({
      cacheRoot,
      run: (
        _cmd: string,
        args: string[],
        options?: { timeout?: number; env?: NodeJS.ProcessEnv },
      ) => {
        calls.push({
          args,
          timeout: options?.timeout,
          cache: options?.env?.npm_config_cache,
        });
        return JSON.stringify({
          version: "0.1.0-beta.2",
          "dist.shasum": SHASUM,
          "dist.integrity": INTEGRITY,
        });
      },
      readState: getNpmRegistryState,
    });
    return { calls, reader };
  };

  it("limits each npm view to the deadline that is left", () => {
    // `runSync` defaults to 120s per call. Without this, one hanging read could outlast the whole
    // wait — seven of them plus the schedule reach 937s against a 120s contract.
    const { calls, reader } = runOf("/tmp/wait-cache");

    reader(SPEC, { attempt: 1, remainingMs: 120_000 });
    reader(SPEC, { attempt: 2, remainingMs: 43_210 });

    expect(calls.map((call) => call.timeout)).toEqual([120_000, 43_210]);
  });

  it("does not round a budget up to something it can spend", () => {
    // A `Math.max(1, Math.floor(remainingMs))` here turned a 0.4ms remainder into a 1ms process.
    // The wait floors and refuses below 1ms, so this only has to refuse to paper over it.
    const { calls, reader } = runOf("/tmp/wait-cache");

    expect(() => reader(SPEC, { attempt: 1, remainingMs: 0.4 })).toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it("gives every attempt a cache directory of its own", () => {
    // The documented guarantee is that a cached negative cannot survive into a later attempt.
    // `--prefer-online` revalidates; a separate directory removes the question.
    const { calls, reader } = runOf("/tmp/wait-cache");

    reader(SPEC, { attempt: 1, remainingMs: 120_000 });
    reader(SPEC, { attempt: 2, remainingMs: 110_000 });
    reader(SPEC, { attempt: 3, remainingMs: 100_000 });

    const caches = calls.map((call) => call.cache);
    expect(caches).toEqual([
      "/tmp/wait-cache/attempt-1",
      "/tmp/wait-cache/attempt-2",
      "/tmp/wait-cache/attempt-3",
    ]);
    expect(new Set(caches).size).toBe(3);
  });

  it("still pins both registry keys and reads online", () => {
    const { calls, reader } = runOf("/tmp/wait-cache");

    reader(SPEC, { attempt: 1, remainingMs: 120_000 });

    expect(calls[0]?.args).toEqual([
      "view",
      SPEC,
      "version",
      "dist.shasum",
      "dist.integrity",
      "--json",
      "--registry=https://registry.npmjs.org/",
      "--@fairux:registry=https://registry.npmjs.org/",
      "--prefer-online",
    ]);
  });
});

describe("production reader composed with the wait — the classification that actually reaches it", () => {
  /**
   * The wait's `read_failed` and read-`timed_out` branches were unreachable in production:
   * `getNpmRegistryState` caught every error and returned `unavailable`, so a killed subprocess and
   * an expired credential arrived as "the registry said something odd". Testing the wait against a
   * throwing fake proved the branch existed, not that anything could reach it — so these compose the
   * real reader with the real classifier and only mock the subprocess.
   */
  const composed = (run: () => string) => {
    let clock = 0;
    return waitForRegistryVersion({
      spec: SPEC,
      expectedShasum: SHASUM,
      expectedIntegrity: INTEGRITY,
      readState: createRegistryReader({ cacheRoot: "/tmp/wait-cache", run }),
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    });
  };

  const throwing = (init: Record<string, unknown>) => () => {
    throw Object.assign(new Error(String(init.message ?? "npm view failed")), init);
  };

  it("reports a subprocess the deadline killed as a timeout", async () => {
    await expect(
      composed(
        throwing({ code: "ETIMEDOUT", message: "npm view timed out", stderr: "", stdout: "" }),
      ),
    ).rejects.toMatchObject({ reason: REGISTRY_WAIT_FAILURES.TIMED_OUT });
  });

  it("reports an auth failure as a failed read, and does not wait it out", async () => {
    await expect(
      composed(throwing({ stderr: "npm ERR! code E401\nnpm ERR! 401 Unauthorized", stdout: "" })),
    ).rejects.toMatchObject({ reason: REGISTRY_WAIT_FAILURES.READ_FAILED });
  });

  it("reports a 5xx as a failed read rather than a version on its way", async () => {
    await expect(
      composed(throwing({ stderr: "npm ERR! 500 Internal Server Error", stdout: "" })),
    ).rejects.toMatchObject({ reason: REGISTRY_WAIT_FAILURES.READ_FAILED });
  });

  it("reports malformed metadata as unavailable", async () => {
    await expect(composed(() => "{not json")).rejects.toMatchObject({
      reason: REGISTRY_WAIT_FAILURES.UNAVAILABLE,
    });
  });

  it("treats only E404 as absent, and retries it on the schedule", async () => {
    let calls = 0;
    let clock = 0;
    const run = () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("npm view failed"), {
          stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found",
          stdout: "",
        });
      }
      return JSON.stringify({
        version: "0.1.0-beta.2",
        "dist.shasum": SHASUM,
        "dist.integrity": INTEGRITY,
      });
    };
    const sleeps: number[] = [];

    await expect(
      waitForRegistryVersion({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        readState: createRegistryReader({ cacheRoot: "/tmp/wait-cache", run }),
        sleep: async (ms: number) => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
      }),
    ).resolves.toMatchObject({ attempts: 3 });
    expect(sleeps).toEqual([2_000, 5_000]);
  });

  it("refuses a budget the wait would never hand it", () => {
    // The wait floors the remainder and never passes less than 1ms, so anything else is a caller
    // bug — and clamping it here would spend budget the deadline did not grant.
    const reader = createRegistryReader({ cacheRoot: "/tmp/wait-cache", run: () => "{}" });
    for (const remainingMs of [0, -5, 0.4, Number.NaN]) {
      expect(() => reader(SPEC, { attempt: 1, remainingMs })).toThrow(TypeError);
    }
  });
});

describe("programmatic wait — the API cannot reach a mode the CLI never uses", () => {
  const matching = () => present();

  it("refuses the wait without a deadline-aware reader", async () => {
    // The fallback was `getNpmRegistryState`, which ignores the read context: no subprocess
    // timeout, no per-attempt cache, no typed timeout. Measured against a 500ms `npm` with a 50ms
    // deadline, that call blocked for over a second before the post-read check caught it.
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        requirePresent: true,
        waitForPresent: true,
        log: () => {},
      } as never),
    ).rejects.toThrow(RegistryPlanUsageError);
  });

  it("names the reader that satisfies the contract", async () => {
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        requirePresent: true,
        waitForPresent: true,
        log: () => {},
      } as never),
    ).rejects.toThrow(/createRegistryReader/);
  });

  it("accepts a reader that honours the read context", async () => {
    const reader = createRegistryReader({
      cacheRoot: "/tmp/wait-cache",
      run: () =>
        JSON.stringify({
          version: "0.1.0-beta.2",
          "dist.shasum": SHASUM,
          "dist.integrity": INTEGRITY,
        }),
    });

    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        requirePresent: true,
        waitForPresent: true,
        readState: reader,
        sleep: async () => {},
        now: () => 0,
        log: () => {},
      }),
    ).resolves.toEqual({ publishNeeded: false, status: "present" });
  });

  it("leaves the single-read modes free to omit a reader", async () => {
    // Those do one read and report; there is no deadline for a reader to honour.
    const calls: string[] = [];
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        readState: (spec: string) => {
          calls.push(spec);
          return matching();
        },
        log: () => {},
      }),
    ).resolves.toMatchObject({ status: "present" });
    expect(calls).toEqual([SPEC]);
  });

  it("passes an explicit deadline through to validation instead of dropping it", async () => {
    // `...(maxElapsedMs ? {…} : {})` dropped `0` and `NaN`, so an invalid deadline silently became
    // the 120s default and the read went ahead.
    for (const maxElapsedMs of [0, Number.NaN, -1]) {
      let reads = 0;
      await expect(
        runRegistryPlan({
          spec: SPEC,
          expectedShasum: SHASUM,
          expectedIntegrity: INTEGRITY,
          requirePresent: true,
          waitForPresent: true,
          maxElapsedMs,
          readState: () => {
            reads += 1;
            return matching();
          },
          sleep: async () => {},
          now: () => 0,
          log: () => {},
        }),
      ).rejects.toThrow(TypeError);
      expect(reads, `maxElapsedMs: ${String(maxElapsedMs)}`).toBe(0);
    }
  });

  it("uses a positive explicit deadline rather than the default", async () => {
    let clock = 0;
    const error = await runRegistryPlan({
      spec: SPEC,
      expectedShasum: SHASUM,
      expectedIntegrity: INTEGRITY,
      requirePresent: true,
      waitForPresent: true,
      maxElapsedMs: 4_000,
      delaysMs: [2_000, 2_000],
      readState: () => ({ status: "absent" }),
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      log: () => {},
    }).catch((thrown: unknown) => thrown);

    expect((error as Error).message).toContain("4000ms registry deadline");
    expect(clock).toBeLessThanOrEqual(4_000);
  });
});
