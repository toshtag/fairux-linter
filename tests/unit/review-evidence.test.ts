import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — the collector is plain JS, like every other script here.
import { collect } from "../../scripts/collect-review-evidence.mjs";
import { verifyFullScripts } from "../../scripts/verify-full-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKET = readFileSync(join(ROOT, "docs/maintainers/security-review.md"), "utf8");

interface Evidence {
  commit: { sha: string; worktreeClean: boolean };
  toolchain: { lockfileSha256: string; packageManager: string };
  publishedPackages: { name: string; version: string; files: string[] }[];
  workflows: { file: string; triggers: unknown; permissions: unknown; jobs: unknown[] }[];
  actionPins: { action: string; ref: string; pinnedBySha: boolean; usedIn: string[] }[];
  surfaceArtifacts: { path: string; sha256: string }[];
  verification: { command: string; steps: { script: string; covers: string }[] };
}

const evidence = collect() as Evidence;
const serialized = JSON.stringify(evidence);

/**
 * The bundle a reviewer is handed, and the two ways handing somebody a bundle goes wrong.
 *
 * It can leak — an absolute path naming a maintainer's home directory, a token, a registry
 * credential. And it can be a **copy**: an inventory typed out once and then quietly disagreeing
 * with the tree, which is worse than no inventory, because a reviewer has no way to tell.
 *
 * Both are checked mechanically. "I did not include anything sensitive" is exactly the claim a
 * person gets wrong once.
 */
describe("what the review evidence must not contain", () => {
  it("carries no absolute path, on either platform's spelling", () => {
    // The collector reads files by absolute path and must report none of them.
    expect(serialized).not.toMatch(/"\/(?:Users|home|root|var|tmp|opt)\//);
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
    expect(serialized).not.toContain(ROOT);
  });

  it("carries nothing that looks like a credential", () => {
    for (const pattern of [
      /ghp_[A-Za-z0-9]/,
      /github_pat_/,
      /npm_[A-Za-z0-9]{20}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY/,
      /authToken/i,
      /\bNODE_AUTH_TOKEN\b/,
    ]) {
      expect(serialized, `matched ${pattern}`).not.toMatch(pattern);
    }
  });

  it("reads no environment at all", () => {
    // The cheapest way for a secret to reach a bundle is a dump of `process.env`. The collector's
    // source must not reach for it, rather than the output happening not to contain one today.
    const source = readFileSync(join(ROOT, "scripts/collect-review-evidence.mjs"), "utf8");
    expect(source).not.toMatch(/process\.env/);
  });
});

describe("what the review evidence must contain", () => {
  it("places the review in time, so a finding is about a tree", () => {
    expect(evidence.commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof evidence.commit.worktreeClean).toBe("boolean");
    expect(evidence.toolchain.lockfileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("covers every workflow in the tree, with its triggers and permissions", () => {
    // The set, not a count: a workflow added and not collected is a privilege surface a reviewer
    // was never shown.
    const onDisk = readdirSync(join(ROOT, ".github/workflows"))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();
    expect(evidence.workflows.map((workflow) => workflow.file)).toEqual(onDisk);
    for (const workflow of evidence.workflows) {
      expect(workflow.triggers, `${workflow.file} has no triggers`).not.toBeNull();
      expect(workflow.jobs.length, `${workflow.file} has no jobs`).toBeGreaterThan(0);
    }
  });

  it("reports the privileged publish job as privileged", () => {
    // The negative control for the permission collection: if it reported `null` everywhere, every
    // assertion above would still pass and the one job that can publish would look inert.
    const publish = evidence.workflows.find((workflow) => workflow.file === "publish-cli.yml");
    const jobs = (publish?.jobs ?? []) as {
      name: string;
      permissions: Record<string, string> | null;
    }[];
    expect(jobs.length, "publish-cli.yml should have jobs").toBeGreaterThan(0);
    const job = jobs.find((entry) => entry.name === "publish");
    expect(job?.permissions).toMatchObject({ "id-token": "write" });
  });

  it("names every action with the commit it is pinned to", () => {
    expect(evidence.actionPins.length).toBeGreaterThan(0);
    for (const pin of evidence.actionPins) {
      expect(pin.pinnedBySha, `${pin.action}@${pin.ref}`).toBe(true);
      expect(pin.usedIn.length).toBeGreaterThan(0);
    }
  });

  it("derives the verification steps rather than restating them", () => {
    // The property that keeps the packet honest: a reviewer told to "run everything this repository
    // runs" runs what it actually runs.
    expect(evidence.verification.steps.map((step) => step.script)).toEqual(verifyFullScripts());
    expect(evidence.verification.command).toBe("pnpm verify:full");
  });

  it("digests each artifact that describes a public surface", () => {
    expect(evidence.surfaceArtifacts.map((artifact) => artifact.path)).toContain(
      "docs/generated/cli-surface-inventory.json",
    );
    for (const artifact of evidence.surfaceArtifacts) {
      expect(artifact.sha256, artifact.path).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("the packet points at things rather than restating them", () => {
  it("sends the reviewer to the threat model instead of carrying a second copy", () => {
    expect(PACKET).toContain("security-boundary.md");
    expect(PACKET).toContain("SECURITY.md");
    expect(PACKET).toContain("pnpm review:evidence");
  });

  it("carries no inventory that would go stale", () => {
    // A packet listing the workflows, the actions, or the verify steps would be wrong the first time
    // one changed — and a reviewer has no way to tell a stale inventory from a current one.
    for (const workflow of evidence.workflows.map((entry) => entry.file)) {
      if (workflow === "publish-cli.yml") continue; // named as a boundary, not as an inventory
      expect(PACKET, `the packet should not list ${workflow}`).not.toContain(workflow);
    }
    for (const step of verifyFullScripts()) {
      if (step === "build") continue;
      expect(PACKET, `the packet should not list pnpm ${step}`).not.toContain(`pnpm ${step}`);
    }
  });

  it("does not claim the review happened", () => {
    // The one sentence this page exists to not become. `S6` is a review, and a packet is
    // preparation for one.
    expect(PACKET).toMatch(/is not evidence that one occurred|stays open/);
    expect(PACKET).not.toMatch(/has been reviewed by|review is complete/i);
  });
});
