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
const runs = jobs
  .flatMap(([, job]) => job.steps ?? [])
  .map((step) => step.run ?? "")
  .join("\n");

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
  it("runs both supported Node.js floors", () => {
    expect(parsed.jobs["consumer-smoke"]?.strategy?.matrix?.["node-version"]).toEqual([
      "22.18.0",
      "24.11.0",
    ]);
  });

  it("resolves the exact version with the existing registry state reader", () => {
    expect(runs).toContain("packages/sdk/scripts/npm-registry-state.mjs");
    expect(runs).toContain('--spec "@fairux/sdk@next"');
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
    expect(run).toContain("scripts/check-semver.mjs");
    // Against the write itself, not a comment that merely mentions the file.
    const writeIndex = run.indexOf('>> "$GITHUB_ENV"');
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("check-semver.mjs")).toBeLessThan(writeIndex);
  });

  it("validates input safety, not the release path's beta-only policy", () => {
    // What `next` may carry is a publication policy owned by the P20 release gate; a consumer
    // canary that borrowed that gate would fail the day the dist-tag advances to an rc or a
    // stable version, with no consumer-compatibility fact behind the failure.
    expect(runs).not.toContain("check-sdk-release-version.mjs");
  });

  it("uploads the registry state and smoke log as evidence", () => {
    const upload = jobs
      .flatMap(([, job]) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload).toBeDefined();
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
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
  // is part of this workflow's contract: the canary must assert the public consumer contract,
  // and must not hold a published SDK to this checkout's generated catalog — between a
  // governance change on `main` and the next SDK publication the two legitimately differ.
  const smoke = readFileSync(resolve(root, "packages/sdk/scripts/registry-smoke-test.mjs"), "utf8");
  const consumer = readFileSync(resolve(root, "packages/sdk/scripts/consumer-smoke.mjs"), "utf8");
  const packSmoke = readFileSync(resolve(root, "packages/sdk/scripts/pack-smoke-test.mjs"), "utf8");

  it("runs the consumer smoke in the registry-consumer profile, explicitly", () => {
    expect(smoke).toContain('profile: "registry-consumer"');
  });

  it("keeps the exact-catalog comparison on the release profile the pack smoke uses", () => {
    // The catalog copy is the release-only claim, so it must sit behind the release gate — and
    // the pack/tarball caller must keep taking the default rather than opting out of it.
    expect(consumer).toContain('if (profile === "release")');
    expect(consumer).toContain("rule-catalog.json");
    expect(packSmoke).not.toContain("profile:");
  });

  it("never infers the profile", () => {
    expect(consumer).not.toMatch(/profile\s*=[^=].*expectedVersion/);
    expect(consumer).toContain('options.profile ?? "release"');
  });
});
