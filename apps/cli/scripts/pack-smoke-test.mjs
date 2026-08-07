#!/usr/bin/env node
/**
 * Publish-VIABILITY smoke test for the `fairux` package — the gate that stops a broken publish.
 *
 * Scope (P10-T2): prove `pnpm pack` can produce a working, publishable tarball — it rewrites
 * `workspace:*`, runs a self-contained prepack (builds the CLI + its workspace deps), and the result
 * installs and runs. To prove prepack doesn't lean on a prior CI build, it DELETES every dist first,
 * then packs — a missing pre-build surfaces here, not in prod.
 *
 * It asks the registry nothing about what is published. That the publish command accepts these bytes
 * is rehearsed by `pnpm release:dry-run:cli`, on the channel the version actually resolves to; the
 * copy that used to be here ran on a hard-coded `next` and refused every version already on npm.
 *
 * Out of scope (tracked in P10-T13): persisting this exact tarball as a release artifact, pinning it
 * by SHA-256, and publishing that same byte-for-byte tarball via Trusted Publishing/OIDC. This test
 * verifies viability; it does NOT claim the bytes it checked are the bytes that ship.
 *
 * The two halves are deliberately in different modules. What the *archive* must contain is
 * `packed-tarball-contract.mjs`, which the privileged publish job re-runs. What the *installed CLI*
 * must do is `installed-cli-smoke-contract.mjs`, which the registry-installed smoke (M1-R4) will
 * run against a CLI that came from npm rather than from this tarball. What is left here is the part
 * that is specific to a locally packed artifact: pack it, hash it, install it, and dry-run publish.
 *
 * Everything runs identically on Linux and Windows (M1-R3): digests come from `node:crypto` rather
 * than `sha256sum`, the archive is read with Node built-ins rather than `tar` and `sh`, `npm` and
 * `pnpm` are launched through the shared runner that knows about `.cmd` shims, and the CLI is
 * invoked through the executable npm generated — `fairux.cmd` on Windows — rather than a hard-coded
 * `node_modules/.bin/fairux`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/run-command.mjs";
import { installedCliBinPath, runInstalledCliSmoke } from "./installed-cli-smoke-contract.mjs";
import { auditPackedCliTarball } from "./packed-tarball-contract.mjs";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliDir, "..", "..");

const TIMEOUT = 120_000;
const run = (cmd, args, opts = {}) => runCommand(cmd, args, { timeout: TIMEOUT, ...opts }).stdout;

let failed = false;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => {
  console.error(`✗ ${m}`);
  failed = true;
};
const assert = (cond, m) => (cond ? ok(m) : bad(m));

const work = mkdtempSync(join(tmpdir(), "fairux-pack-"));
// The tarball and the consuming project are separate directories: the installed-CLI contract
// writes fixtures and a discovered config into its project, and none of that should sit next to
// the artifact under audit.
const packDir = join(work, "tarball");
const projectDir = join(work, "project");
mkdirSync(packDir);
mkdirSync(projectDir);

try {
  // If TARBALL env is set, we verify a pre-packed tarball (from the publish workflow).
  // Otherwise, we pack ourselves (for CI pack-smoke job and local dev).
  let tarball;
  if (process.env.TARBALL && existsSync(process.env.TARBALL)) {
    tarball = resolve(process.env.TARBALL);
    ok(`verifying pre-packed tarball: ${tarball}`);
    // Verify SHA-256 if expected hash is provided. `node:crypto`, not `sha256sum`: the release
    // dry-run hands this env var to the same script on every platform, and Windows has no
    // `sha256sum` — a missing binary would have failed the run rather than the digest.
    if (process.env.EXPECTED_SHA256) {
      const actualSha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
      assert(
        actualSha === process.env.EXPECTED_SHA256,
        `tarball SHA-256 matches expected (${actualSha} === ${process.env.EXPECTED_SHA256})`,
      );
    }
  } else {
    // Prove prepack self-containment: remove every dist so pack must rebuild from source.
    for (const p of ["core", "ast", "html", "report", "rules", "dom"]) {
      rmSync(join(repoRoot, "packages", p, "dist"), { recursive: true, force: true });
    }
    rmSync(join(cliDir, "dist"), { recursive: true, force: true });

    // Pack with pnpm (rewrites workspace:*, runs prepack → builds CLI + deps + copies assets).
    run("pnpm", ["pack", "--pack-destination", packDir], { cwd: cliDir });
    const tgz = readdirSync(packDir).find((f) => f.startsWith("fairux-") && f.endsWith(".tgz"));
    if (!tgz) {
      bad("pnpm pack produced no tarball");
      throw new Error("no tarball");
    }
    tarball = join(packDir, tgz);
    ok(`packed ${tgz} (after deleting all dist — prepack rebuilt from source)`);
  }

  // --- Structural contract, shared with the privileged publish job ---
  // These assertions live in packed-tarball-contract.mjs so the publish job can re-run exactly
  // this audit against the downloaded bundle, from the trusted checkout. Keeping one copy is the
  // point: two copies would drift, and the privileged one is the one that matters.
  for (const failure of auditPackedCliTarball({
    tarball,
    sourceManifestPath: join(cliDir, "package.json"),
    repoRoot,
    onPass: ok,
  })) {
    bad(failure);
  }

  // --- Install into a clean temp project (no workspace linkage) ---
  run("npm", ["init", "-y"], { cwd: projectDir });
  run("npm", ["install", tarball, "--no-audit", "--no-fund"], { cwd: projectDir });
  ok("installed the tarball into a clean temp project");

  try {
    run("npm", ["ls", "--omit=dev"], { cwd: projectDir });
    ok("npm ls --omit=dev reports no missing/invalid runtime deps");
  } catch (e) {
    bad(`npm ls --omit=dev failed:\n${e.message}`);
  }

  // --- The executable npm actually created, not `node dist/index.js` ---
  // A published `bin` that pointed at a file npm never linked would still run under `node`; it is
  // the shim that proves `npx fairux` and a project-local `fairux` work for a consumer.
  const bin = installedCliBinPath(projectDir);
  ok(`installed package exposes the npm-generated bin shim (${bin})`);

  const installedManifest = JSON.parse(
    readFileSync(join(projectDir, "node_modules", "fairux", "package.json"), "utf8"),
  );
  const installedVersion = installedManifest.version;

  // --- The published CLI's behaviour contract, shared with the registry smoke (M1-R4) ---
  for (const failure of runInstalledCliSmoke({
    runCli: (args, { expectStatus = 0, input, cwd = projectDir } = {}) =>
      runCommand(bin, args, { cwd, input, expectStatus, timeout: TIMEOUT }),
    projectDir,
    packageVersion: installedVersion,
    onPass: ok,
  })) {
    bad(failure);
  }

  // What npm would publish, read from the tarball rather than asked of npm.
  //
  // `npm publish --dry-run` used to run here on the same tarball. Measured on this checkout it has
  // two outcomes and neither is a fact about the bytes: against the real registry it answers
  // `EPUBLISHCONFLICT` for any version already published — which `main` carries between a release
  // and the next bump — and against a registry it cannot reach it exits 0 and prints the archive.
  // A check that fails when the registry is up and passes when it is down is not a check.
  //
  // What it asserted was the package name, the version, and that `dist/index.js` is in the file
  // list. All three are in the archive `auditPackedCliTarball` already opened, and the installed
  // copy above is npm's own unpacking of it — so they are asserted from what a consumer actually
  // received. The command a privileged job runs, on the channel this version resolves to, is
  // rehearsed by `pnpm release:dry-run:cli`, which is where a registry belongs.
  assert(installedManifest.name === "fairux", "installed package is named fairux");
  assert(
    installedManifest.version ===
      JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version,
    `installed version matches the checkout (${installedVersion})`,
  );
  assert(
    existsSync(join(projectDir, "node_modules", "fairux", "dist", "index.js")),
    "installed package ships dist/index.js",
  );

  console.log(failed ? "\n✗ pack smoke test FAILED" : "\n✓ pack smoke test passed");
} catch (err) {
  console.error(`✗ pack smoke test errored: ${err.message}`);
  failed = true;
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
