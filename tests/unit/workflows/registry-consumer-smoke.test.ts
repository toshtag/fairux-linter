import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the registry consumer smoke workflow to its boundary, not to its shell.
 *
 * The workflow is P18-T2's continuous half: it resolves `@fairux/sdk@next` to an exact published
 * version with the existing registry state reader and runs the existing registry smoke against it.
 * What this contract holds is the shape that keeps it safe and honest — observation-only triggers,
 * read-only permissions, both supported Node.js floors, the existing scripts rather than a second
 * resolver, and uploaded evidence. Comment prose, step wording, and shell formatting are
 * deliberately not contract: `action-runtime-contract.test.ts` already walks this file for action
 * pins, and `publish-oidc-contract.test.ts` owns the publish privilege boundary this workflow must
 * simply never enter.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Step[];
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const text = readFileSync(resolve(root, ".github/workflows/registry-consumer-smoke.yml"), "utf8");
const parsed = parse(text) as Workflow;
const jobs = Object.entries(parsed.jobs);
const steps = jobs.flatMap(([, job]) => job.steps ?? []);
const runs = steps.map((step) => step.run ?? "").join("\n");

describe("registry-consumer-smoke.yml triggers", () => {
  it("runs only on manual dispatch and a schedule", () => {
    // The exact key set is the assertion: adding `pull_request` or `push` would put a
    // public-registry observation in the way of unrelated changes.
    expect(Object.keys(parsed.on ?? {}).sort()).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("schedules a real cron entry", () => {
    const schedule = parsed.on?.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule).toHaveLength(1);
    expect(schedule?.[0]?.cron).toMatch(/^[\d*/, -]+$/);
  });
});

describe("registry-consumer-smoke.yml privilege boundary", () => {
  it("holds contents: read and nothing else, workflow-wide", () => {
    expect(parsed.permissions).toEqual({ contents: "read" });
    for (const [name, job] of jobs) {
      expect(job.permissions, `${name} must not widen the workflow permissions`).toBeUndefined();
    }
  });

  it("can mint no token and write nothing", () => {
    expect(text).not.toMatch(/id-token/);
    expect(text).not.toMatch(/\b(?:contents|packages):\s*write/);
    expect(text).not.toMatch(/secrets\./);
    for (const [, job] of jobs) {
      for (const step of job.steps ?? []) {
        for (const name of Object.keys(step.env ?? {})) {
          expect(name).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
        }
      }
    }
  });

  it("cannot publish", () => {
    expect(runs).not.toContain("npm publish");
    // `registry-url` writes a credential placeholder into the npm user config; a consumer
    // observation has no business carrying one.
    for (const [, job] of jobs) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/setup-node@")) {
          expect(step.with?.["registry-url"]).toBeUndefined();
        }
      }
    }
  });
});

describe("registry-consumer-smoke.yml execution", () => {
  it("runs both supported Node.js floors, on both published channels", () => {
    const matrix = parsed.jobs["consumer-smoke"]?.strategy?.matrix;
    expect(matrix?.["node-version"]).toEqual(["22.18.0", "24.11.0"]);
    // `next` is not dropped when `latest` starts being watched. They name different versions
    // published by different runs, so a green canary on one is not evidence about the other.
    expect(matrix?.channel).toEqual(["next", "latest"]);
  });

  it("resolves the exact version with the existing registry state reader", () => {
    expect(runs).toContain("packages/sdk/scripts/npm-registry-state.mjs");
    // Through the matrix, not a literal channel: `next` and `latest` are separate facts and this
    // canary observes each of them.
    expect(runs).toContain('--spec "$SDK_SPEC"');
    const channelEnv = steps
      .filter((step) => step.run?.includes('--spec "$SDK_SPEC"'))
      .map((step) => String(step.env?.SDK_SPEC ?? ""));
    expect(channelEnv.length).toBeGreaterThan(0);
    for (const value of channelEnv) {
      expect(value).toBe("@fairux/sdk@${{ matrix.channel }}");
    }
    // The workflow shell is wiring, not a second resolver.
    expect(runs).not.toContain("npm view");
  });

  it("feeds the resolved exact version to the existing registry smoke", () => {
    expect(runs).toContain("pnpm registry:smoke:sdk");
    expect(runs).toContain('SDK_SPEC="@fairux/sdk@$SDK_VERSION"');
    expect(runs).toContain('EXPECTED_VERSION="$SDK_VERSION"');
  });

  it("validates the resolved version before exporting it to later steps", () => {
    // The registry response is untrusted input; an unvalidated value written to GITHUB_ENV could
    // define arbitrary variables for the steps that follow.
    const resolveStep = jobs
      .flatMap(([, job]) => job.steps ?? [])
      .find((step) => step.run?.includes("GITHUB_ENV"));
    const run = resolveStep?.run ?? "";
    // One resolver owns the whole decision now: status, the bootstrap placeholder, strict SemVer,
    // and the write. The four shell lines it replaced could each be edited independently, and the
    // placeholder case was not among them — so a `latest` still holding `0.0.0-bootstrap.0` would
    // have been installed and smoked green, because there is nothing in a name reservation to
    // break.
    expect(run).toContain("scripts/resolve-registry-channel.mjs");
    expect(run).toContain("--github-env");
    // The shell no longer writes to GITHUB_ENV itself, so there is no unvalidated path to it.
    expect(run).not.toContain('>> "$GITHUB_ENV"');
    expect(runs).not.toContain("node -p");
  });

  it("validates input safety, not the release path's version policy", () => {
    // What a channel may carry is a publication policy owned by the release gate; a consumer canary
    // that borrowed that gate would fail the day the dist-tag advances to a version the gate
    // refuses, with no consumer-compatibility fact behind the failure.
    expect(runs).not.toContain("check-sdk-release-version.mjs");
  });

  it("uploads the registry state and smoke log as evidence", () => {
    const upload = jobs
      .flatMap(([, job]) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload).toBeDefined();
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    // One artifact per cell: four runs writing the same name would collide.
    expect(String(upload?.with?.name)).toContain("${{ matrix.channel }}");
    expect(String(upload?.with?.name)).toContain("${{ matrix.node-version }}");
    expect(runs).toContain("registry-state.json");
    expect(runs).toContain("registry-smoke.log");
  });

  it("installs the workspace only for the smoke harness, never as the SDK source", () => {
    expect(runs).toContain("pnpm install --frozen-lockfile");
    // No local tarball and no workspace specifier may reach the temp consumer; the smoke itself
    // installs `@fairux/sdk` from the public registry.
    expect(runs).not.toContain("pack ");
    expect(runs).not.toMatch(/workspace:/);
  });
});

describe("registry smoke profile", () => {
  // The workflow reaches the consumer smoke through `registry:smoke:sdk`, so the profile split
  // is part of this workflow's contract: the canary must assert the frozen, versioned public
  // consumer contract, not this checkout's evolving release fixtures — between a change on
  // `main` and the next SDK publication the two legitimately differ. The fixture-level fence
  // (which trees each profile stages, v1 independence) lives in
  // `registry-consumer-contract.test.ts`.
  const smoke = readFileSync(resolve(root, "packages/sdk/scripts/registry-smoke-test.mjs"), "utf8");
  const consumer = readFileSync(resolve(root, "packages/sdk/scripts/consumer-smoke.mjs"), "utf8");
  const packSmoke = readFileSync(resolve(root, "packages/sdk/scripts/pack-smoke-test.mjs"), "utf8");

  it("runs the consumer smoke in the registry-consumer profile, explicitly", () => {
    expect(smoke).toContain('profile: "registry-consumer"');
    // The logged contract identity comes from the validated manifest, not from a guess.
    expect(smoke).toContain("validateRegistryConsumerContract()");
  });

  it("selects fixtures through the one profile selector the tests pin", () => {
    // The pack/tarball caller keeps taking the default rather than opting out of the release
    // claim, and the smoke stages whatever the selector answers — no second fixture list.
    expect(consumer).toContain("consumerSmokeFixtureNames(profile)");
    expect(packSmoke).not.toContain("profile:");
  });

  it("never infers the profile", () => {
    expect(consumer).not.toMatch(/profile\s*=[^=].*expectedVersion/);
    expect(consumer).toContain('options.profile ?? "release"');
  });
});
