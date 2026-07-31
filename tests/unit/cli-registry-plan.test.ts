import { describe, expect, it } from "vitest";
import {
  createRegistryReader,
  parseRegistryPlanArgs,
  RegistryPlanUsageError,
  runRegistryPlan,
} from "../../apps/cli/scripts/release-registry-plan.mjs";
import type { NpmRegistryState } from "../../scripts/npm-registry-state.d.mts";
import { readNpmRegistryState } from "../../scripts/npm-registry-state.mjs";
import {
  NPM_CLI_PUBLISH_REGISTRY_ARGS,
  NPM_CLI_VIEW_REGISTRY_ARGS,
  NPM_SDK_VIEW_REGISTRY_ARGS,
} from "../../scripts/public-npm-registry.mjs";

/**
 * The CLI's half of the publication plan.
 *
 * `publish-cli.yml` called `npm publish` unconditionally: a rerun of a successful release went red
 * on `E409`, a version already present with different bytes was left to the registry to reject
 * with no explanatory failure, and nothing compared what npm stored to what the workflow audited.
 *
 * The plan's own three-state logic is the shared module's, and `packages/sdk/test/` already pins it
 * against the SDK. What is CLI-specific — and what these cover — is the binding: an unscoped
 * package's registry arguments, and the fact that the CLI wrapper actually reaches the same rules.
 *
 * Nothing here touches a registry. Every read is injected.
 */

const SPEC = "fairux@0.1.0-beta.1";
const SHASUM = "a".repeat(40);
const INTEGRITY = `sha512-${"b".repeat(86)}==`;

const silent = () => {};

function present(overrides: Partial<Extract<NpmRegistryState, { status: "present" }>> = {}) {
  return {
    status: "present" as const,
    version: "0.1.0-beta.1",
    shasum: SHASUM,
    integrity: INTEGRITY,
    ...overrides,
  };
}

describe("the CLI's registry arguments", () => {
  it("names the public registry and asks for a fresh read", () => {
    expect(NPM_CLI_VIEW_REGISTRY_ARGS).toEqual([
      "--registry=https://registry.npmjs.org/",
      "--prefer-online",
    ]);
  });

  it("pins no scope key, because fairux is unscoped", () => {
    // The SDK must pin `@fairux:registry` — npm resolves a scoped package through it before it
    // falls back to `registry`. `fairux` has no scope key for npm to look up, so a pin here would
    // suggest a resolution path this package does not have.
    expect(NPM_CLI_VIEW_REGISTRY_ARGS.join(" ")).not.toContain("@fairux:registry");
    expect(NPM_CLI_PUBLISH_REGISTRY_ARGS).toEqual(["--registry=https://registry.npmjs.org/"]);
    expect(NPM_SDK_VIEW_REGISTRY_ARGS.join(" ")).toContain("@fairux:registry");
  });

  it("reaches npm with exactly those arguments", () => {
    const calls: string[][] = [];
    readNpmRegistryState(SPEC, {
      registryArgs: NPM_CLI_VIEW_REGISTRY_ARGS,
      run: (_cmd, args) => {
        calls.push(args);
        return JSON.stringify({
          version: "0.1.0-beta.1",
          dist: { shasum: SHASUM, integrity: INTEGRITY },
        });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(-2)).toEqual([...NPM_CLI_VIEW_REGISTRY_ARGS]);
  });

  it("refuses to read with no registry named", () => {
    // A default would mean one caller silently reading a different host than it publishes to.
    expect(() =>
      readNpmRegistryState(SPEC, { registryArgs: [] as string[], run: () => "{}" }),
    ).toThrow(TypeError);
  });
});

describe("runRegistryPlan, through the CLI wrapper", () => {
  it("asks for a publish when the version is absent", async () => {
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        readState: () => ({ status: "absent" }),
        log: silent,
      }),
    ).resolves.toEqual({ publishNeeded: true, status: "absent" });
  });

  it("skips the publish when the same digest is already there", async () => {
    // The rerun case. Without this, `npm publish` returned E409 and a run that had already
    // succeeded was recorded as a failure.
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        readState: () => present(),
        log: silent,
      }),
    ).resolves.toEqual({ publishNeeded: false, status: "present" });
  });

  it("fails hard on a shasum conflict rather than skipping or retrying", async () => {
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        readState: () => present({ shasum: "c".repeat(40) }),
        log: silent,
      }),
    ).rejects.toThrow(/different digest/);
  });

  it("fails hard on an integrity conflict even when the shasum matches", async () => {
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        readState: () => present({ integrity: `sha512-${"z".repeat(86)}==` }),
        log: silent,
      }),
    ).rejects.toThrow(/different digest/);
  });

  it("fails when the registry answer is unusable", async () => {
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        readState: () => ({ status: "unavailable", reason: "malformed JSON" }),
        log: silent,
      }),
    ).rejects.toThrow(/unavailable/);
  });

  it("fails when a required version is absent after the publish", async () => {
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        requirePresent: true,
        readState: () => ({ status: "absent" }),
        log: silent,
      }),
    ).rejects.toThrow(/absent from npm after publish/);
  });
});

describe("wait mode", () => {
  it("retries an absent version and succeeds when it appears", async () => {
    const answers: NpmRegistryState[] = [{ status: "absent" }, { status: "absent" }, present()];
    let clock = 0;
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        requirePresent: true,
        waitForPresent: true,
        readState: () => answers.shift() ?? present(),
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        log: silent,
      }),
    ).resolves.toEqual({ publishNeeded: false, status: "present" });
    expect(answers).toHaveLength(0);
  });

  it("does not retry a digest mismatch", async () => {
    // The rule the SDK's incident taught: absence is the only state a propagation delay produces.
    // Retrying a mismatch turns "the digests do not match" into "npm was slow".
    let reads = 0;
    let clock = 0;
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        requirePresent: true,
        waitForPresent: true,
        readState: () => {
          reads += 1;
          return present({ shasum: "d".repeat(40) });
        },
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        log: silent,
      }),
    ).rejects.toThrow(/different shasum/);
    expect(reads).toBe(1);
  });

  it("refuses wait mode with no deadline-aware reader", async () => {
    await expect(
      runRegistryPlan({
        spec: SPEC,
        expectedShasum: SHASUM,
        expectedIntegrity: INTEGRITY,
        requirePresent: true,
        waitForPresent: true,
        log: silent,
      }),
    ).rejects.toThrow(RegistryPlanUsageError);
  });

  it("refuses waiting on the pre-publish read", () => {
    expect(() =>
      parseRegistryPlanArgs([
        "--spec",
        SPEC,
        "--shasum",
        SHASUM,
        "--integrity",
        INTEGRITY,
        "--wait-for-present",
      ]),
    ).toThrow(RegistryPlanUsageError);
  });
});

describe("createRegistryReader, bound to the CLI's registry", () => {
  it("passes the CLI registry arguments and the remaining budget to each read", () => {
    const seen: Array<{ args: string[]; timeout: number | undefined; cache: string | undefined }> =
      [];
    const reader = createRegistryReader({
      cacheRoot: "/tmp/does-not-need-to-exist",
      run: (_cmd, args, options) => {
        seen.push({
          args,
          timeout: options?.timeout,
          cache: options?.env?.npm_config_cache as string | undefined,
        });
        return JSON.stringify({
          version: "0.1.0-beta.1",
          dist: { shasum: SHASUM, integrity: INTEGRITY },
        });
      },
    });

    expect(reader(SPEC, { attempt: 2, remainingMs: 4321 })).toMatchObject({ status: "present" });
    expect(seen[0].args.slice(-2)).toEqual([...NPM_CLI_VIEW_REGISTRY_ARGS]);
    expect(seen[0].timeout).toBe(4321);
    // Per attempt, so a cached negative cannot survive into the next one.
    expect(seen[0].cache).toContain("attempt-2");
  });

  it("refuses a budget the wait did not grant", () => {
    const reader = createRegistryReader({ cacheRoot: "/tmp/x", run: () => "{}" });
    expect(() => reader(SPEC, { attempt: 1, remainingMs: 0 })).toThrow(TypeError);
    expect(() => reader(SPEC, { attempt: 1, remainingMs: 0.4 })).toThrow(TypeError);
  });
});
