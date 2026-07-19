#!/usr/bin/env node
/**
 * Publish-VIABILITY smoke test for the `fairux` package — the gate that stops a broken publish.
 *
 * Scope (P10-T2): prove `pnpm pack` can produce a working, publishable tarball — it rewrites
 * `workspace:*`, runs a self-contained prepack (builds the CLI + its workspace deps), and the result
 * installs and runs. It also runs `npm publish --dry-run` on that tarball, so the chosen publish
 * command (`npm publish <tarball>`) is known to accept it. To prove prepack doesn't lean on a prior
 * CI build, it DELETES every dist first, then packs — a missing pre-build surfaces here, not in prod.
 *
 * Out of scope (tracked in P10-T13): persisting this exact tarball as a release artifact, pinning it
 * by SHA-256, and publishing that same byte-for-byte tarball via Trusted Publishing/OIDC. This test
 * verifies viability; it does NOT claim the bytes it checked are the bytes that ship.
 *
 * Checks: tarball manifest is a valid public package (name/version/bin/deps/no workspace:); the
 * payload contains dist/index.js + README/LICENSE/NOTICE and no src/test/scripts; the bundle inlines
 * @fairux/* but NOT typescript/parse5 and stays under a size cap; the installed CLI runs --version,
 * scans HTML/JSX/TSX, and an explicit fairux.config.ts actually takes effect (proven by a marker).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const sourceManifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
  const manifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"]));
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  assert(manifest.name === "fairux", `manifest name is "fairux" (got "${manifest.name}")`);
  assert(SEMVER.test(manifest.version), `manifest version is valid SemVer (${manifest.version})`);
  assert(
    manifest.version === sourceManifest.version,
    `manifest version matches source (${manifest.version} === ${sourceManifest.version})`,
  );
  assert(manifest.private !== true, "manifest is not private");
  assert(manifest.type === "module", 'manifest type is "module"');
  assert(manifest.license === "Apache-2.0", `manifest license is Apache-2.0 (${manifest.license})`);
  // Check engines against the SOURCE manifest, not a hardcoded literal, so raising the supported
  // Node range (e.g. ">=20" -> ">=22") can't silently diverge between the package and this smoke test.
  assert(
    manifest.engines?.node === sourceManifest.engines?.node,
    `manifest engines.node matches source (${manifest.engines?.node} === ${sourceManifest.engines?.node})`,
  );
  assert(
    manifest.repository?.directory === "apps/cli",
    `manifest repository.directory is apps/cli (${manifest.repository?.directory})`,
  );
  assert(manifest.bin?.fairux === "./dist/index.js", "bin.fairux points at ./dist/index.js");
  const runtimeDeps = Object.keys(manifest.dependencies ?? {}).sort();
  assert(
    JSON.stringify(runtimeDeps) === JSON.stringify(["commander", "jiti", "parse5", "typescript"]),
    `runtime deps are exactly commander/jiti/parse5/typescript (got ${runtimeDeps.join(",")})`,
  );
  // typescript is used as a runtime compiler API; its range must not be wide-open (^).
  assert(
    !manifest.dependencies.typescript.startsWith("^"),
    `typescript range is pinned/tilde, not caret (${manifest.dependencies.typescript})`,
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

  // --- Tarball payload: ALLOWLIST (a widened `files` could otherwise ship secrets/junk) ---
  const entries = run("tar", ["-tzf", tarball])
    .split("\n")
    .filter(Boolean)
    .map((e) => e.replace(/^package\//, ""));
  for (const required of ["dist/index.js", "README.md", "LICENSE", "NOTICE", "package.json"]) {
    assert(entries.includes(required), `tarball contains ${required}`);
  }
  const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|dist\/.*)$/;
  const unexpected = entries.filter((e) => !ALLOWED.test(e));
  assert(
    unexpected.length === 0,
    `tarball contains only allowed paths (unexpected: ${unexpected.join(",") || "none"})`,
  );

  // --- README is the package-specific one, not the repo-root dev README ---
  const readme = run("tar", ["-xzOf", tarball, "package/README.md"]);
  assert(/npx fairux scan/.test(readme), "README has npm-user quick start (npx fairux scan)");
  assert(!/pnpm install\s*\n\s*pnpm build/.test(readme), "README is not the clone-dev README");
  assert(!/@fairux\/core/.test(readme), "README config example does not import @fairux/core");

  // --- README's Node requirement must match the published engines (no split-brain contract) ---
  // Derive the required major from manifest.engines.node (">=22" -> 22) and assert the README
  // declares exactly that, and does NOT advertise any LOWER major — so bumping engines without
  // updating the user-facing README fails here (P10-T3 treats the runtime as a published contract).
  const engineMajor = Number(String(manifest.engines?.node ?? "").match(/(\d+)/)?.[1]);
  assert(
    Number.isInteger(engineMajor),
    `manifest engines.node has a major version (${manifest.engines?.node})`,
  );
  const nodeReq = /Node(?:\.js)?\s*(?:≥|>=)\s*(\d+)/g;
  const declaredMajors = [...readme.matchAll(nodeReq)].map((m) => Number(m[1]));
  assert(
    declaredMajors.includes(engineMajor),
    `README declares Node >= ${engineMajor} (matches engines; found ${declaredMajors.join(", ") || "none"})`,
  );
  assert(
    declaredMajors.every((major) => major >= engineMajor),
    `README does not advertise a Node major below ${engineMajor} (found ${declaredMajors.join(", ")})`,
  );

  // --- Bundle composition: @fairux/* inlined, typescript/parse5 external, total dist size bounded ---
  const distJs = run("tar", ["-xzOf", tarball, "package/dist/index.js"]);
  assert(
    !/(from|import|require\()\s*["']@fairux\//.test(distJs),
    "dist has no unresolved @fairux/* import/require (inlined)",
  );
  assert(
    /from\s*["']typescript["']/.test(distJs),
    "dist imports typescript externally (not inlined)",
  );
  assert(/from\s*["']parse5["']/.test(distJs), "dist imports parse5 externally (not inlined)");
  assert(
    !/function createTypeChecker|ts\.factory\b/.test(distJs),
    "typescript compiler not inlined",
  );
  // Sum ALL dist/ entries (not just index.js) so a bloated sourcemap can't slip through.
  const distTotal = run("sh", [
    "-c",
    `tar -xzf ${JSON.stringify(tarball)} -O $(tar -tzf ${JSON.stringify(tarball)} | grep '^package/dist/') | wc -c`,
  ]);
  const distBytes = Number(distTotal.trim());
  assert(
    distBytes > 0 && distBytes < MAX_TARBALL_DIST_BYTES,
    `total dist/ under ${MAX_TARBALL_DIST_BYTES} bytes (${distBytes})`,
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

  // The INSTALLED CLI's version must equal the tarball manifest's version — not merely be non-empty.
  // This is the publish-boundary check the workspace test can't make: it proves the build-time
  // injection (tsup define → __FAIRUX_VERSION__) survived into the packed-and-installed artifact, so
  // a fallback (0.0.0-dev) or a stale constant would FAIL here, not pass. (P10-T3)
  const version = run(bin, ["--version"]).trim();
  assert(
    version === manifest.version,
    `installed fairux --version matches tarball manifest (${version} === ${manifest.version})`,
  );

  // --- Scan HTML / JSX / TSX (and pin report.toolVersion to the manifest on the first scan) ---
  const fixtures = {
    "page.html": "<html><body><button>OK</button></body></html>",
    "Comp.jsx": "const C = () => <button>OK</button>;\n",
    "Comp.tsx": "const C = (): JSX.Element => <button>OK</button>;\n",
  };
  let firstScan = true;
  for (const [name, body] of Object.entries(fixtures)) {
    const f = join(work, name);
    writeFileSync(f, body, "utf8");
    const report = JSON.parse(run(bin, ["scan", f, "--format", "json", "--ignore-config"]));
    ok(`scanned ${name} → valid JSON report`);
    if (firstScan) {
      // report.toolVersion flows from the same injected VERSION; pin it on the installed artifact.
      assert(
        report.toolVersion === manifest.version,
        `installed JSON report.toolVersion matches tarball manifest (${report.toolVersion} === ${manifest.version})`,
      );
      // SARIF is a published interface too — its tool.driver.version must match as well.
      const sarif = JSON.parse(run(bin, ["scan", f, "--format", "sarif", "--ignore-config"]));
      const sarifVersion = sarif.runs?.[0]?.tool?.driver?.version;
      assert(
        sarifVersion === manifest.version,
        `installed SARIF tool.driver.version matches tarball manifest (${sarifVersion} === ${manifest.version})`,
      );
      firstScan = false;
    }
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

  // --- npm publish --dry-run on the SAME tarball: the chosen publish command must accept it ---
  // (P10-T2 proves the tarball is publishable; the single-artifact pack→verify→publish pipeline,
  // artifact persistence, SHA-256 pinning, and Trusted Publishing are P10-T13.)
  try {
    const dryRaw = run(
      "npm",
      ["publish", "--dry-run", "--json", "--ignore-scripts", "--tag", "next", tarball],
      {
        cwd: work,
      },
    );
    // On newer npm (Node 24+), npm notice lines may appear on stdout before the JSON.
    // Extract just the JSON object to be resilient across npm versions.
    const jsonStart = dryRaw.indexOf("{");
    const jsonEnd = dryRaw.lastIndexOf("}");
    const dry =
      jsonStart >= 0 && jsonEnd > jsonStart ? dryRaw.slice(jsonStart, jsonEnd + 1) : dryRaw;
    const parsed = JSON.parse(dry);
    // npm 10 (Node 22) emits a flat object; npm 11 (Node 24) nests under the package name key.
    const published = parsed.name ? parsed : (parsed.fairux ?? Object.values(parsed)[0]);
    assert(
      published.name === "fairux",
      `publish dry-run package name is fairux (${published.name})`,
    );
    assert(
      published.version === manifest.version,
      `publish dry-run version matches the tarball (${published.version})`,
    );
    const files = (published.files ?? []).map((f) => f.path ?? f);
    assert(
      files.some((p) => /(^|\/)dist\/index\.js$/.test(p)),
      "publish dry-run includes dist/index.js",
    );
    ok("npm publish --dry-run accepts the tarball");
  } catch (e) {
    bad(
      `npm publish --dry-run failed:\n${(e.stdout || e.stderr || e.message || "").slice(0, 600)}`,
    );
  }

  console.log(failed ? "\n✗ pack smoke test FAILED" : "\n✓ pack smoke test passed");
} catch (err) {
  console.error(`✗ pack smoke test errored: ${err.message}`);
  failed = true;
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
