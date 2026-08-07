import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the registry CLI smoke workflow to its boundary, not to its shell.
 *
 * The workflow is M1-R4's continuous half: it resolves `fairux@next` to an exact published version
 * with the existing registry state reader and runs the existing registry smoke against it. What
 * this contract holds is the shape that keeps it safe and honest — observation-only triggers,
 * read-only permissions, both platform targets on both Node.js floors, the existing scripts rather
 * than a second resolver, and uploaded evidence. Comment prose, step wording, and shell formatting
 * are deliberately not contract: `action-runtime-contract.test.ts` already walks this file for
 * action pins, and `publish-cli-contract.test.ts` owns the publish privilege boundary this workflow
 * must simply never enter.
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
  "runs-on"?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Step[];
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const text = readFileSync(resolve(root, ".github/workflows/registry-cli-smoke.yml"), "utf8");
const parsed = parse(text) as Workflow;
const jobs = Object.entries(parsed.jobs);
const steps = jobs.flatMap(([, job]) => job.steps ?? []);
const runs = steps.map((step) => step.run ?? "").join("\n");

describe("registry-cli-smoke.yml triggers", () => {
  it("runs only on manual dispatch and a schedule", () => {
    // The exact key set is the assertion. This workflow is red until `fairux` is published, so a
    // `pull_request` or `push` trigger would put that absence in front of every unrelated change.
    expect(Object.keys(parsed.on ?? {}).sort()).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("schedules a real cron entry", () => {
    const schedule = parsed.on?.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule).toHaveLength(1);
    expect(schedule?.[0]?.cron).toMatch(/^[\d*/, -]+$/);
  });

  it("does not queue against the SDK canary", () => {
    const sdk = readFileSync(
      resolve(root, ".github/workflows/registry-consumer-smoke.yml"),
      "utf8",
    );
    const cronOf = (source: string) => /- cron: "([^"]+)"/.exec(source)?.[1];
    expect(cronOf(text)).toBeDefined();
    expect(cronOf(text)).not.toBe(cronOf(sdk));
  });
});

describe("registry-cli-smoke.yml privilege boundary", () => {
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
    for (const step of steps) {
      for (const name of Object.keys(step.env ?? {})) {
        expect(name).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
      }
    }
  });

  it("cannot publish", () => {
    expect(runs).not.toContain("npm publish");
    // `registry-url` writes a credential placeholder into the npm user config; a consumer
    // observation has no business carrying one.
    for (const step of steps) {
      if (step.uses?.startsWith("actions/setup-node@")) {
        expect(step.with?.["registry-url"]).toBeUndefined();
      }
    }
  });
});

describe("registry-cli-smoke.yml execution", () => {
  it("runs both platform targets on both supported Node.js floors", () => {
    // Four cells, the same ones M1-R3 established for the packed CLI. npm writes a different bin
    // shim on Windows and the CLI's path handling differs there, so a green Linux install is not
    // evidence about Windows.
    const matrix = parsed.jobs["cli-smoke"]?.strategy?.matrix;
    expect(matrix?.os).toEqual(["ubuntu-latest", "windows-latest"]);
    expect(matrix?.["node-version"]).toEqual(["22.18.0", "24.11.0"]);
    // Eight cells, not four: `next` is what a prerelease user installs and `latest` is what a bare
    // `npm install --global fairux` resolves. `next` is not dropped when `latest` starts being
    // watched — they name different versions published by different runs.
    expect(matrix?.channel).toEqual(["next", "latest"]);
    expect(parsed.jobs["cli-smoke"]?.["runs-on"]).toBe("${{ matrix.os }}");
  });

  it("resolves the exact version with the existing registry state reader", () => {
    expect(runs).toContain("apps/cli/scripts/npm-registry-state.mjs");
    // Through the matrix, not a literal channel: `next` and `latest` are separate facts and this
    // canary observes each of them.
    expect(runs).toContain('--spec "$CLI_SPEC"');
    const channelEnv = steps
      .filter((step) => step.run?.includes('--spec "$CLI_SPEC"'))
      .map((step) => String(step.env?.CLI_SPEC ?? ""));
    expect(channelEnv.length).toBeGreaterThan(0);
    for (const value of channelEnv) {
      expect(value).toBe("fairux@${{ matrix.channel }}");
    }
    // The workflow shell is wiring, not a second resolver.
    expect(runs).not.toContain("npm view");
    // The CLI's reader, not the SDK's: `fairux` is unscoped and must not carry a scope pin.
    expect(runs).not.toContain("packages/sdk/scripts/npm-registry-state.mjs");
  });

  it("feeds the resolved exact version to the existing registry smoke", () => {
    expect(runs).toContain("pnpm registry:smoke:cli");
    expect(runs).toContain('CLI_SPEC="fairux@$CLI_VERSION"');
    expect(runs).toContain('EXPECTED_VERSION="$CLI_VERSION"');
  });

  it("validates the resolved version before exporting it to later steps", () => {
    // The registry response is untrusted input; an unvalidated value written to GITHUB_ENV could
    // define arbitrary variables for the steps that follow.
    const resolveStep = steps.find((step) => step.run?.includes("GITHUB_ENV"));
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
    // What a channel may carry is a publication policy owned by the release gate; a canary that
    // borrowed that gate would fail the day the dist-tag advances to a version the gate refuses,
    // with no consumer-compatibility fact behind the failure.
    expect(runs).not.toContain("check-cli-release-version.mjs");
  });

  it("uploads the registry state and smoke log as evidence", () => {
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload).toBeDefined();
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    // One artifact per cell: four runs writing the same name would collide.
    // One artifact per cell: eight runs writing the same name would collide.
    expect(String(upload?.with?.name)).toContain("${{ matrix.channel }}");
    expect(String(upload?.with?.name)).toContain("${{ matrix.os }}");
    expect(String(upload?.with?.name)).toContain("${{ matrix.node-version }}");
    expect(runs).toContain("registry-state.json");
    expect(runs).toContain("registry-smoke.log");
  });

  it("installs the workspace only for the smoke harness, never as the CLI source", () => {
    expect(runs).toContain("pnpm install --frozen-lockfile");
    // No local tarball and no workspace specifier may reach the temp project; the smoke itself
    // installs `fairux` from the public registry.
    expect(runs).not.toContain("pnpm pack");
    expect(runs).not.toContain("pack:smoke");
    expect(runs).not.toMatch(/workspace:/);
  });

  it("runs bash on both targets, so pipefail is on where the log is teed", () => {
    // Windows defaults to `pwsh`, where only the last command's status is reported: a failing
    // `pnpm registry:smoke:cli` piped into `tee` would be reported as a pass.
    const workflowDefaults = parse(text) as { jobs: Record<string, { defaults?: unknown }> };
    expect(workflowDefaults.jobs["cli-smoke"]?.defaults).toEqual({ run: { shell: "bash" } });
    expect(runs).toContain("| tee");
  });
});

describe("one behaviour contract, not two", () => {
  const smoke = readFileSync(resolve(root, "apps/cli/scripts/registry-smoke-test.mjs"), "utf8");
  const packSmoke = readFileSync(resolve(root, "apps/cli/scripts/pack-smoke-test.mjs"), "utf8");

  it("reaches the same installed-CLI contract the packed smoke runs", () => {
    for (const source of [smoke, packSmoke]) {
      expect(source).toContain("./installed-cli-smoke-contract.mjs");
      expect(source).toContain("runInstalledCliSmoke");
    }
  });

  it("keeps packing and tarball auditing out of the registry path", () => {
    // The two paths differ in provenance, not in what the CLI must do. Auditing an archive here
    // would be auditing a different artifact than the one npm served.
    expect(smoke).not.toContain("auditPackedCliTarball");
    expect(packSmoke).toContain("auditPackedCliTarball");
  });
});
