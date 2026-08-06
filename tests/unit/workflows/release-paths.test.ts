import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * `release-paths.yml` — the release checks a pull request can break, run on the pull request.
 *
 * The lane a contributor waits for does not exercise the release path; `release-contract.yml` does,
 * after a merge. This workflow is the narrow slice that runs earlier, and each of its parts is there
 * because of a measured failure rather than a category:
 *
 * - two scripts the unit suite cannot see, because the suite drives the pure contract with in-memory
 *   file lists and never packs or assembles anything;
 * - both pack smokes, after three pull requests each passed every check they were given and together
 *   pushed the SDK browser bundle past a ceiling only a packed tarball reveals.
 *
 * What this file guards is the second failure repeating quietly: a `paths` filter narrowed back to
 * manifests, or a job deleted, would restore the gap and nothing else would say so.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = parse(
  readFileSync(resolve(root, ".github/workflows/release-paths.yml"), "utf8"),
) as {
  on: { pull_request: { paths: string[] } };
  jobs: Record<string, { steps: { run?: string; uses?: string }[] }>;
};

const runsOf = (job: string) =>
  (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? "").join("\n");

describe("release-paths.yml", () => {
  it("runs on pull requests, filtered", () => {
    expect(workflow.on.pull_request.paths.length).toBeGreaterThan(0);
  });

  it("watches what the published tarballs are built from, not only what describes them", () => {
    // The gap that let the bundle-size regression through: every changed file was under
    // `packages/*/src`, and the filter named only manifests, packaging scripts, and workflows.
    const paths = workflow.on.pull_request.paths;
    expect(paths).toContain("packages/*/src/**");
    expect(paths).toContain("apps/cli/src/**");
    // And the ones that were already right.
    expect(paths).toContain("apps/cli/package.json");
    expect(paths).toContain("packages/sdk/package.json");
    expect(paths).toContain("scripts/**");
    expect(paths).toContain(".github/workflows/publish-cli.yml");
    expect(paths).toContain(".github/workflows/publish-sdk.yml");
  });

  it("runs both pack smokes on a pull request", () => {
    const runs = runsOf("package-smokes");
    expect(runs).toContain("pnpm pack:smoke\n");
    expect(runs).toContain("pnpm pack:smoke:sdk");
  });

  it("still runs the two contracts the unit suite cannot see", () => {
    const runs = runsOf("release-paths");
    expect(runs).toContain("scripts/test-release-bundle-handoff.mjs");
    expect(runs).toContain("scripts/test-packed-artifact-contract.mjs");
  });

  it("publishes nothing and asks no registry what exists", () => {
    // The line between this workflow and `release-contract.yml`'s registry jobs. A check that needed
    // a token or a network could not run on a fork's pull request at all.
    for (const job of Object.keys(workflow.jobs)) {
      const runs = runsOf(job);
      expect(runs, job).not.toMatch(/npm publish(?!\s+--dry-run)|npm dist-tag|registry:smoke/);
      expect(runs, job).not.toMatch(/release:check|release:dry-run|verify-published/);
    }
  });

  it("asserts every job left the worktree clean", () => {
    // Both halves, in both jobs: `git diff` sees a modified tracked file, and an untracked one only
    // shows up in `status`. Each of these scripts packs a tarball into a directory it creates.
    for (const job of Object.keys(workflow.jobs)) {
      const runs = runsOf(job);
      expect(runs, job).toContain("git diff --exit-code");
      expect(runs, job).toContain('test -z "$(git status --porcelain)"');
    }
  });

  it("grants no write permission", () => {
    const text = readFileSync(resolve(root, ".github/workflows/release-paths.yml"), "utf8");
    expect(text).toContain("permissions:\n  contents: read");
    expect(text).not.toMatch(/contents:\s*write|id-token:\s*write/);
  });
});
