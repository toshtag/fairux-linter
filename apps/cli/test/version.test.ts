import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Version single-source-of-truth (P10-T3). The CLI version is no longer a hand-edited constant in
 * src/index.ts (it had drifted: source said 0.3.0 while package.json said 0.1.0). tsup inlines it
 * from package.json at build time, so `fairux --version` must equal the version npm publishes.
 *
 * This asserts the BUILT binary, not the source module: under the test runner esbuild's `define`
 * never runs, so the source falls back to a sentinel. Only the built dist proves the injection.
 * Like cli-security.test.ts, this needs `dist/index.js` — run via `pnpm verify` (builds first).
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "../dist/index.js");
const pkgPath = resolve(here, "../package.json");

if (!existsSync(cliEntry)) {
  throw new Error(
    `Version test requires the built CLI at ${cliEntry}, and it's missing. ` +
      `Run "pnpm verify" or "pnpm --filter '@fairux/cli...' build" first.`,
  );
}

const pkgVersion = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

describe("CLI version (single-sourced from package.json)", () => {
  it("`fairux --version` matches apps/cli/package.json version", () => {
    const res = spawnSync("node", [cliEntry, "--version"], { encoding: "utf8", timeout: 10_000 });
    expect(res.status).toBe(0);
    expect(res.signal).toBeNull();
    expect(res.stdout.trim()).toBe(pkgVersion);
  });

  it("report.toolVersion in a JSON scan matches the package version", () => {
    const example = resolve(here, "../../../examples/checkout.html");
    // --ignore-config isolates the version assertion from config discovery: a stray fairux.config.*
    // anywhere up the tree must not turn a version test into a config/rule failure.
    const res = spawnSync(
      "node",
      [cliEntry, "scan", example, "--format", "json", "--ignore-config"],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    // Check status AND signal: a signal-killed process leaves status null, which `status ?? 0`
    // would wave through as success. Match the `--version` test's exit assertion above.
    expect(res.status).toBe(0);
    expect(res.signal).toBeNull();
    const report = JSON.parse(res.stdout) as { toolVersion: string };
    expect(report.toolVersion).toBe(pkgVersion);
  });
});
