import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERIFY_FULL_STEPS, verifyFullScripts } from "../../scripts/verify-full-contract.mjs";

/**
 * `pnpm verify:full` and the pull-request lane, kept from drifting apart.
 *
 * The gate exists because a contributor could not run what CI runs: `pnpm verify` covers lint, a
 * typecheck, the suite, and runtime safety, and everything else — the generated artifacts, the
 * document and fixture checks, the two pack smokes — lived only in `ci.yml`. A composition that
 * quietly stopped matching that lane would be the same problem with more ceremony, so the two are
 * compared here rather than trusted to stay aligned.
 *
 * Deliberately narrow. This does not assert the *order* of the two lists (CI parallelises what a
 * local run does in sequence), does not pin a count, and does not read the prose. It asserts that
 * every script the lane runs is in the gate, that every script the gate names exists, and that the
 * two package smokes CI cannot afford on a pull request are the gate's own additions.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

/**
 * Every `- run: pnpm <script>` in `ci.yml`, without the arguments a shard passes.
 *
 * `install` is pnpm's own command rather than a repository script, and a local gate runs against a
 * tree that is already installed.
 */
const PNPM_BUILT_INS = new Set(["install"]);

function ciPnpmScripts(): string[] {
  const found = new Set<string>();
  for (const match of ci.matchAll(/^\s*-\s*run:\s*pnpm\s+([\w:-]+)/gm)) {
    const script = match[1] as string;
    if (!PNPM_BUILT_INS.has(script)) found.add(script);
  }
  return [...found].sort();
}

describe("pnpm verify:full", () => {
  it("is wired up, and runs the script rather than reimplementing it", () => {
    expect(packageJson.scripts["verify:full"]).toBe("node scripts/verify-full.mjs");
  });

  it("leaves the fast gate alone", () => {
    // `pnpm verify` is what a contributor runs while working, and CONTRIBUTING calls it the
    // baseline. A change to it is a change to that promise and should not arrive as a side effect.
    expect(packageJson.scripts.verify).toBe(
      "pnpm lint && pnpm typecheck && pnpm test:built && pnpm check:runtime-safety",
    );
  });

  it("names only scripts that exist", () => {
    for (const script of verifyFullScripts()) {
      expect(packageJson.scripts, script).toHaveProperty(script);
    }
  });

  it("names each script once", () => {
    const scripts = verifyFullScripts();
    expect(new Set(scripts).size).toBe(scripts.length);
  });

  it("covers every pnpm script the pull-request lane runs", () => {
    // The direction that matters. A check added to `ci.yml` and not here is a check a contributor
    // still cannot run before pushing, which is the whole reason this gate exists.
    const missing = ciPnpmScripts().filter((script) => !verifyFullScripts().includes(script));
    expect(missing).toEqual([]);
  });

  it("adds the two pack smokes the pull-request lane deliberately does not run", () => {
    // They pack a tarball and take about ten seconds each; `release-contract.yml` runs them after
    // the merge. A completion PR should have run them locally first, which is what this gate is for.
    expect(verifyFullScripts()).toContain("pack:smoke");
    expect(verifyFullScripts()).toContain("pack:smoke:sdk");
    expect(ciPnpmScripts()).not.toContain("pack:smoke");
    expect(ciPnpmScripts()).not.toContain("pack:smoke:sdk");
  });

  it("stays offline: nothing it runs asks a registry what is published", () => {
    // The release contracts need ownership this gate must not require, and a gate that fails
    // because a network is down teaches people to skip it.
    for (const script of verifyFullScripts()) {
      const command = packageJson.scripts[script] as string;
      expect(command, script).not.toMatch(/registry:smoke|release:check|release:dry-run/);
    }
  });

  it("explains every step, so the list is readable rather than a shell line", () => {
    for (const step of VERIFY_FULL_STEPS as readonly { script: string; why: string }[]) {
      expect(step.why.length, step.script).toBeGreaterThan(20);
    }
  });
});

/**
 * The SDK browser bundle's two ceilings, written down twice.
 *
 * `consumer-smoke.mjs` and `pack-smoke-test.mjs` each declare their own copy, and only the second
 * runs in `pnpm verify:full`. Two numbers that are supposed to be one number will eventually differ,
 * and the way that shows up is a gate passing locally and the same check failing after a merge —
 * which is the failure this whole PR is about.
 *
 * The numbers themselves are not asserted here. What they should be is a maintainer's call, argued
 * in the comment above each; that they agree is not.
 */
describe("the SDK browser bundle budget", () => {
  const budgets = (file: string) => {
    const text = readFileSync(resolve(root, "packages/sdk/scripts", file), "utf8");
    return {
      raw: /const MAX_BROWSER_BUNDLE_BYTES = (.+);/.exec(text)?.[1],
      minified: /const MAX_MINIFIED_BROWSER_BUNDLE_BYTES = (.+);/.exec(text)?.[1],
    };
  };

  it("is the same in both places that declare it", () => {
    const consumer = budgets("consumer-smoke.mjs");
    expect(consumer.raw).toBeDefined();
    expect(consumer.minified).toBeDefined();
    expect(budgets("pack-smoke-test.mjs")).toEqual(consumer);
  });
});
