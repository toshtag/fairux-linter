#!/usr/bin/env node
/**
 * Publish smoke test for the `fairux` package — the gate that stops a broken publish.
 *
 * Publish path (decided): `pnpm pack` produces the tarball (rewriting `workspace:*` to concrete
 * versions and running prepack, which builds the CLI + its workspace deps), then `npm publish
 * <tarball>` ships that exact, smoke-tested tarball. So this test packs with pnpm and asserts the
 * tarball is self-contained and usable.
 *
 * To prove prepack is self-contained (not relying on a prior CI build), it DELETES every dist first,
 * then packs — so a missing pre-build surfaces here instead of in production.
 *
 * Checks: tarball manifest is a valid public package (name/version/bin/deps/no workspace:); the
 * payload contains dist/index.js + README/LICENSE/NOTICE and no src/test/scripts; the bundle inlines
 * @fairux/* but NOT typescript/parse5 and stays under a size cap; the installed CLI runs --version,
 * scans HTML/JSX/TSX, and an explicit fairux.config.ts actually takes effect (proven by a marker).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliDir, "..", "..");
const MAX_TARBALL_DIST_BYTES = 2 * 1024 * 1024; // dist must stay small (typescript must NOT be inlined)

const TIMEOUT = 120_000;
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
}

let failed = false;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => {
  console.error(`✗ ${m}`);
  failed = true;
};
const assert = (cond, m) => (cond ? ok(m) : bad(m));

const work = mkdtempSync(join(tmpdir(), "fairux-pack-"));
try {
  // Prove prepack self-containment: remove every dist so pack must rebuild from source.
  for (const p of ["core", "ast", "html", "report", "rules", "dom"]) {
    rmSync(join(repoRoot, "packages", p, "dist"), { recursive: true, force: true });
  }
  rmSync(join(cliDir, "dist"), { recursive: true, force: true });

  // Pack with pnpm (rewrites workspace:*, runs prepack → builds CLI + deps + copies assets).
  run("pnpm", ["pack", "--pack-destination", work], { cwd: cliDir });
  const tgz = readdirSync(work).find((f) => f.startsWith("fairux-") && f.endsWith(".tgz"));
  if (!tgz) {
    bad("pnpm pack produced no tarball");
    throw new Error("no tarball");
  }
  const tarball = join(work, tgz);
  ok(`packed ${tgz} (after deleting all dist — prepack rebuilt from source)`);

  // --- Tarball manifest: structural, not string-grep ---
  const manifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"]));
  assert(manifest.name === "fairux", `manifest name is "fairux" (got "${manifest.name}")`);
  assert(
    manifest.version && /^\d/.test(manifest.version),
    `manifest version set (${manifest.version})`,
  );
  assert(manifest.private !== true, "manifest is not private");
  assert(manifest.bin?.fairux === "./dist/index.js", "bin.fairux points at ./dist/index.js");
  const runtimeDeps = Object.keys(manifest.dependencies ?? {}).sort();
  assert(
    JSON.stringify(runtimeDeps) === JSON.stringify(["commander", "jiti", "parse5", "typescript"]),
    `runtime deps are exactly commander/jiti/parse5/typescript (got ${runtimeDeps.join(",")})`,
  );
  // No workspace: in ANY dependency map of the published manifest.
  const allDepStrings = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]
    .map((k) => JSON.stringify(manifest[k] ?? {}))
    .join("");
  assert(
    !allDepStrings.includes("workspace:"),
    "manifest has no workspace: specifier in any dep map",
  );

  // --- Tarball payload: required files present, junk absent ---
  const entries = run("tar", ["-tzf", tarball])
    .split("\n")
    .filter(Boolean)
    .map((e) => e.replace(/^package\//, ""));
  for (const required of ["dist/index.js", "README.md", "LICENSE", "NOTICE", "package.json"]) {
    assert(entries.includes(required), `tarball contains ${required}`);
  }
  const junk = entries.filter((e) => /^(src|test|scripts)\//.test(e));
  assert(
    junk.length === 0,
    `tarball excludes src/test/scripts (found: ${junk.join(",") || "none"})`,
  );

  // --- Bundle composition: @fairux/* inlined, typescript/parse5 external, size bounded ---
  const distJs = run("tar", ["-xzOf", tarball, "package/dist/index.js"]);
  assert(!/from\s*["']@fairux\//.test(distJs), "dist has no unresolved @fairux/* import (inlined)");
  assert(
    /from\s*["']typescript["']/.test(distJs),
    "dist imports typescript externally (not inlined)",
  );
  assert(/from\s*["']parse5["']/.test(distJs), "dist imports parse5 externally (not inlined)");
  assert(
    !/function createTypeChecker|ts\.factory\b/.test(distJs),
    "typescript compiler not inlined",
  );
  assert(
    Buffer.byteLength(distJs) < MAX_TARBALL_DIST_BYTES,
    `dist/index.js under ${MAX_TARBALL_DIST_BYTES} bytes (${Buffer.byteLength(distJs)})`,
  );

  // --- Install into a clean temp project (no workspace linkage) ---
  run("npm", ["init", "-y"], { cwd: work });
  run("npm", ["install", tarball, "--no-audit", "--no-fund"], { cwd: work });
  ok("installed the tarball into a clean temp project");

  const bin = join(work, "node_modules", ".bin", "fairux");
  assert(existsSync(bin), "installed package exposes the `fairux` bin");

  try {
    run("npm", ["ls", "--omit=dev"], { cwd: work });
    ok("npm ls --omit=dev reports no missing/invalid runtime deps");
  } catch (e) {
    bad(`npm ls --omit=dev failed:\n${e.stdout || e.message}`);
  }

  const version = run(bin, ["--version"]).trim();
  assert(Boolean(version), `fairux --version runs (${version})`);

  // --- Scan HTML / JSX / TSX ---
  const fixtures = {
    "page.html": "<html><body><button>OK</button></body></html>",
    "Comp.jsx": "const C = () => <button>OK</button>;\n",
    "Comp.tsx": "const C = (): JSX.Element => <button>OK</button>;\n",
  };
  for (const [name, body] of Object.entries(fixtures)) {
    const f = join(work, name);
    writeFileSync(f, body, "utf8");
    JSON.parse(run(bin, ["scan", f, "--format", "json", "--ignore-config"]));
    ok(`scanned ${name} → valid JSON report`);
  }

  // --- Explicit executable fairux.config.ts MUST actually take effect (prove via a marker) ---
  const marker = join(work, "CONFIG_LOADED");
  const cfg = join(work, "fairux.config.ts");
  writeFileSync(
    cfg,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, "loaded");\n` +
      `export default {};\n`,
    "utf8",
  );
  const cfgRun = execFileSync(
    bin,
    ["scan", join(work, "page.html"), "--config", cfg, "--format", "json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT,
    },
  );
  JSON.parse(cfgRun);
  assert(
    existsSync(marker),
    "explicit --config fairux.config.ts actually executed (marker written)",
  );

  console.log(failed ? "\n✗ pack smoke test FAILED" : "\n✓ pack smoke test passed");
} catch (err) {
  console.error(`✗ pack smoke test errored: ${err.message}`);
  failed = true;
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
