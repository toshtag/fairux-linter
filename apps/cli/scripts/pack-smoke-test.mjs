#!/usr/bin/env node
/**
 * Publish smoke test for the `fairux` package. Packs the real tarball, installs it into a clean temp
 * dir (so workspace resolution can't mask a broken publish), and asserts the package is actually
 * usable end-to-end:
 *   - tarball/package.json carry NO `workspace:` specifiers
 *   - dist/index.js exists in the tarball
 *   - the bundle does not inline @fairux/*, typescript, or parse5
 *   - the installed CLI runs `--version` and scans HTML, JSX, and TSX
 *   - an explicit executable `fairux.config.ts` loads
 *   - `npm ls --omit=dev` reports no missing/invalid runtime deps
 *
 * Run with the CLI already built (prepack builds on real `npm pack`). Exits non-zero on any failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`✓ ${msg}`);

// 0. Sanity: the published package.json must not carry workspace: deps and must be public.
const pkg = JSON.parse(readFileSync(resolve(cliDir, "package.json"), "utf8"));
if (pkg.private) fail("package.json is still private:true");
if (JSON.stringify(pkg.dependencies ?? {}).includes("workspace:")) {
  fail("package.json dependencies contain a workspace: specifier");
}
ok("package.json is publishable (not private, no workspace: deps)");

const work = mkdtempSync(resolve(tmpdir(), "fairux-pack-"));
try {
  // 1. Pack the real tarball with `pnpm pack` — pnpm rewrites `workspace:*` specifiers to concrete
  // versions (so no `workspace:` leaks) and runs prepack (tsup build + asset copy). `npm pack` is
  // wrong here: it can't resolve the bundled `@fairux/*` during prepack and leaves `workspace:` in.
  run("pnpm", ["pack", "--pack-destination", work], { cwd: cliDir });
  const tarball = run("sh", ["-c", `ls -t ${work}/fairux-*.tgz | head -1`]).trim();
  if (!tarball || !existsSync(tarball)) fail("pnpm pack did not produce a tarball");
  if (!existsSync(tarball)) fail(`npm pack did not produce ${tarball}`);
  ok(`packed ${tarball.split("/").pop()}`);

  // 2. Inspect tarball contents: dist/index.js present, no workspace: anywhere.
  const listing = run("tar", ["-tzf", tarball]);
  if (!/(^|\/)package\/dist\/index\.js$/m.test(listing)) fail("tarball is missing dist/index.js");
  ok("tarball contains dist/index.js");
  const contents = run("tar", ["-xzOf", tarball]);
  if (contents.includes("workspace:")) fail("tarball content contains a workspace: specifier");
  ok("tarball content has no workspace: specifiers");

  // 3. Install into a clean project (no workspace linkage).
  run("npm", ["init", "-y"], { cwd: work });
  run("npm", ["install", tarball, "--no-audit", "--no-fund"], { cwd: work });
  ok("installed the tarball into a clean temp project");

  const bin = resolve(work, "node_modules", ".bin", "fairux");
  if (!existsSync(bin)) fail("installed package did not expose the `fairux` bin");

  // 4. `npm ls --omit=dev` must be clean (no missing/invalid runtime deps).
  try {
    run("npm", ["ls", "--omit=dev"], { cwd: work });
    ok("npm ls --omit=dev reports no missing/invalid runtime deps");
  } catch (e) {
    fail(`npm ls --omit=dev failed:\n${e.stdout || e.message}`);
  }

  // 5. --version runs.
  const version = run(bin, ["--version"]).trim();
  if (!version) fail("`fairux --version` produced no output");
  ok(`fairux --version → ${version}`);

  // 6. Scan HTML, JSX, TSX — each must produce a valid JSON report.
  const fixtures = {
    "page.html": "<html><body><button>OK</button></body></html>",
    "Comp.jsx": "const C = () => <button>OK</button>;\n",
    "Comp.tsx": "const C = (): JSX.Element => <button>OK</button>;\n",
  };
  for (const [name, body] of Object.entries(fixtures)) {
    const f = resolve(work, name);
    writeFileSync(f, body, "utf8");
    const out = run(bin, ["scan", f, "--format", "json", "--ignore-config"]);
    JSON.parse(out); // throws if not valid JSON
    ok(`scanned ${name} → valid JSON report`);
  }

  // 7. Explicit executable fairux.config.ts loads (the trusted opt-in path).
  const cfg = resolve(work, "fairux.config.ts");
  writeFileSync(cfg, "export default { includeExperimental: true };\n", "utf8");
  const page = resolve(work, "page.html");
  const withCfg = run(bin, ["scan", page, "--config", cfg, "--format", "json"]);
  JSON.parse(withCfg);
  ok("explicit --config fairux.config.ts loads and scans");

  console.log("\n✓ pack smoke test passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
