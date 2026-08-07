import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGISTRY_STATE_SUBCOMMANDS,
  reachableFrom,
  registryStateCalls,
} from "../../scripts/offline-gate-contract.mjs";
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

  it("asks no registry what is published, through every script it reaches", () => {
    // This used to match each step's own command string against `registry:smoke|release:check|
    // release:dry-run`. Every step passed, and two of them ran `npm publish --dry-run` one level
    // down: `pack:smoke` is `node apps/cli/scripts/pack-smoke-test.mjs`, and a name match never
    // opened that file. `registryStateCalls` follows the scripts into their sources instead.
    //
    // The property is not "no network". `npm install` is how a pack smoke behaves like a consumer,
    // and the CLI's five runtime dependencies come from a registry. The property is that no answer
    // here changes when this repository publishes — `npm publish --dry-run` returns
    // `EPUBLISHCONFLICT` for a version already on npm, which turned `main` red for three PRs.
    expect(registryStateCalls(root, verifyFullScripts())).toEqual([]);
  });

  it("resolves enough of the tree for that to mean anything", () => {
    // A resolver that followed nothing would report no calls and look identical. The pack smokes
    // are the deepest reach — `pack:smoke` → the smoke script → its contract modules — so their
    // presence is what says the walk went past `package.json`.
    const { files } = reachableFrom(root, verifyFullScripts());
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("apps/cli/scripts/pack-smoke-test.mjs");
    expect(files).toContain("apps/cli/scripts/packed-tarball-contract.mjs");
    expect(files).toContain("packages/sdk/scripts/pack-smoke-test.mjs");
    expect(files).toContain("packages/sdk/scripts/consumer-smoke.mjs");
  });

  it("keeps reaching the deep files it reached before the resolver grew a form", () => {
    // A regression guard for the resolver itself. Adding an import form must not change which files
    // the real gate reaches — the new ones are additions to what is followed, not replacements.
    const { files } = reachableFrom(root, verifyFullScripts());
    for (const file of [
      "scripts/check-build-output.mjs",
      "scripts/build-output-contract.mjs",
      "scripts/evaluate-corpus.mjs",
      "scripts/calibrate-risk-index.mjs",
      "scripts/generate-api-inventory.mjs",
      "packages/rules/scripts/check-reviews.mjs",
      "packages/rules/scripts/detection-digest.mjs",
      "packages/sdk/scripts/audit-browser-module.mjs",
      "packages/sdk/scripts/browser-bundle-budget.mjs",
      "apps/cli/scripts/installed-cli-smoke-contract.mjs",
      "apps/cli/scripts/source-map-audit.mjs",
    ]) {
      expect(files, file).toContain(file);
    }
  });

  it("would catch a registry-state call added one level down", () => {
    // The mutation the old check could not see, run against the resolver rather than the tree.
    const calls = registryStateCalls(root, ["pack:smoke:sdk"]);
    expect(calls).toEqual([]);
    expect(REGISTRY_STATE_SUBCOMMANDS).toContain("publish");
    expect(REGISTRY_STATE_SUBCOMMANDS).toContain("view");
    expect(REGISTRY_STATE_SUBCOMMANDS).toContain("dist-tag");
  });

  it("does not claim the release rehearsals are offline", () => {
    // The other direction, so the check is not vacuously true of everything: `release:dry-run:*` is
    // where a registry belongs, and it still runs the publish dry run.
    for (const script of ["release:dry-run:cli", "release:dry-run:sdk"]) {
      expect(registryStateCalls(root, [script]).length, script).toBeGreaterThan(0);
    }
  });

  it("explains every step, so the list is readable rather than a shell line", () => {
    for (const step of VERIFY_FULL_STEPS as readonly { script: string; why: string }[]) {
      expect(step.why.length, step.script).toBeGreaterThan(20);
    }
  });
});

/**
 * The SDK browser bundle's two ceilings, declared once.
 *
 * `consumer-smoke.mjs` and `pack-smoke-test.mjs` each carried their own copy of both numbers and of
 * the paragraphs arguing for them, and only the second runs in `pnpm verify:full`. This file used to
 * check that the two copies agreed, on the reasoning that "two numbers that are supposed to be one
 * number will eventually differ".
 *
 * Right diagnosis, wrong remedy: a drift test is a way of tolerating a second copy. There is one
 * declaration now — `packages/sdk/scripts/browser-bundle-budget.mjs` — so what this asserts is that
 * it stays the only one.
 *
 * The values themselves are still not asserted. What they should be is a maintainer's call, argued
 * in that module; that there is one place to argue it is not.
 */
describe("the SDK browser bundle budget", () => {
  const scripts = ["browser-bundle-budget.mjs", "consumer-smoke.mjs", "pack-smoke-test.mjs"];
  const sourceOf = (file: string) =>
    readFileSync(resolve(root, "packages/sdk/scripts", file), "utf8");

  it("is declared in exactly one module", () => {
    for (const constant of ["MAX_BROWSER_BUNDLE_BYTES", "MAX_MINIFIED_BROWSER_BUNDLE_BYTES"]) {
      const declaring = scripts.filter((file) =>
        new RegExp(`(?:export )?const ${constant} =`).test(sourceOf(file)),
      );
      expect(declaring, `${constant} is declared in ${declaring.join(", ")}`).toEqual([
        "browser-bundle-budget.mjs",
      ]);
    }
  });

  it("is imported by both smokes rather than restated", () => {
    for (const file of ["consumer-smoke.mjs", "pack-smoke-test.mjs"]) {
      expect(sourceOf(file), file).toContain("./browser-bundle-budget.mjs");
    }
  });

  it("records no current bundle size, which is a fact about one commit", () => {
    // Both copies said "112 KiB against 113,494 bytes today — 1,194 bytes of headroom". Nothing
    // updates that when the bundle grows, and the smokes print the real size on every run.
    for (const file of scripts) {
      expect(sourceOf(file), file).not.toMatch(/\d{2,3},\d{3} bytes today/);
    }
  });
});

/**
 * The import forms the walk has to follow, on a throwaway repository built for each case.
 *
 * The resolver followed `import … from` and `import(…)` and nothing else. `import "./x.mjs";` — the
 * side-effect form, with no binding — was invisible, so a module reached only that way, and
 * everything *it* imports, sat outside the publication-state contract. Nothing in this repository is
 * written that way, which is why it would not have been noticed: one ordinary line was enough.
 *
 * Each case is the shape the contract actually cares about — a root script, a module, and a
 * registry-state call one hop further on — rather than a unit test of a regular expression.
 */
describe("the reachable walk follows every relative import form", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fairux-resolver-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "probe", scripts: { gate: "node scripts/entry.mjs" } }),
    );
    // The registry-state call, always one hop past the entry point.
    writeFileSync(
      join(dir, "scripts", "deep.mjs"),
      'import { execFileSync } from "node:child_process";\n' +
        'export const read = () => execFileSync("npm", ["view", "fairux", "version"]);\n',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (source: string) => writeFileSync(join(dir, "scripts", "entry.mjs"), source);

  it.each([
    ["a side-effect import", 'import "./deep.mjs";\n'],
    ["a named import", 'import { read } from "./deep.mjs";\nread();\n'],
    ["a dynamic import", 'const { read } = await import("./deep.mjs");\nread();\n'],
    ["a named re-export", 'export { read } from "./deep.mjs";\n'],
    ["a star re-export", 'export * from "./deep.mjs";\n'],
    ["a namespace re-export", 'export * as deep from "./deep.mjs";\n'],
  ])("finds the call through %s", (_form, source) => {
    entry(source);
    expect(reachableFrom(dir, ["gate"]).files).toEqual(["scripts/deep.mjs", "scripts/entry.mjs"]);
    expect(registryStateCalls(dir, ["gate"])).toEqual([
      { where: "scripts/deep.mjs", invocation: '"npm", ["view"' },
    ]);
  });

  it("follows a chain of side-effect imports, not just the first hop", () => {
    // The form that hid the defect hides a whole subtree, not one file.
    writeFileSync(join(dir, "scripts", "middle.mjs"), 'import "./deep.mjs";\n');
    entry('import "./middle.mjs";\n');
    expect(reachableFrom(dir, ["gate"]).files).toContain("scripts/deep.mjs");
    expect(registryStateCalls(dir, ["gate"])).toHaveLength(1);
  });

  it("does not mistake an import of a package for a relative one", () => {
    // Only repository files are followed; `node_modules` is where the walk deliberately stops.
    entry('import "node:child_process";\nimport "some-package";\n');
    expect(reachableFrom(dir, ["gate"]).files).toEqual(["scripts/entry.mjs"]);
    expect(registryStateCalls(dir, ["gate"])).toEqual([]);
  });

  it("reports nothing when the deep module asks the registry nothing", () => {
    // The negative control. Every case above would look the same if `registryStateCalls` always
    // returned a finding, or if the fixture were wired wrong.
    writeFileSync(join(dir, "scripts", "quiet.mjs"), 'export const read = () => "no npm here";\n');
    entry('import "./quiet.mjs";\n');
    expect(reachableFrom(dir, ["gate"]).files).toContain("scripts/quiet.mjs");
    expect(registryStateCalls(dir, ["gate"])).toEqual([]);
  });
});
