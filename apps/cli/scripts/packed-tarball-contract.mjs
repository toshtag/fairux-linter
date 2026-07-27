/**
 * Structural contract for the packed `fairux` tarball.
 *
 * Extracted from `pack-smoke-test.mjs` so the **privileged publish job can re-run it**. That job
 * receives a tarball built by an unprivileged job that ran lifecycle scripts, so matching digests
 * only prove the bundle is self-consistent — a lifecycle script that rewrote the tarball and then
 * rewrote the metadata to match would pass identity checks. These assertions look inside the bytes
 * instead, using the auditor from the clean tagged checkout.
 *
 * Everything here works from `tar` and Node built-ins: no `npm install`, no CLI execution, no
 * network. The install-and-run half of the smoke test stays where it was, in the unprivileged job.
 */
import { readFileSync } from "node:fs";
import {
  auditPublishedManifest,
  auditTarMembers,
} from "../../../scripts/packed-publish-contract.mjs";
import { readTarMembers } from "../../../scripts/tar-members.mjs";

const MAX_TARBALL_DIST_BYTES = 2 * 1024 * 1024; // dist must stay small (typescript must NOT be inlined)
const EXPECTED_RUNTIME_DEPS = ["commander", "fast-glob", "jiti", "parse5", "typescript"];

/**
 * @param {object} input
 * @param {string} input.tarball  path to the packed tarball
 * @param {string} input.sourceManifestPath  `apps/cli/package.json` from the trusted checkout
 * @param {(cmd: string, args: string[]) => string} input.run  runs `tar`/`sh`, returns stdout
 * @param {(message: string) => void} [input.onPass]
 * @returns {string[]} failures; empty means the tarball satisfies the contract
 */
export function auditPackedCliTarball({ tarball, sourceManifestPath, run, onPass = () => {} }) {
  const failures = [];
  const ok = (message) => onPass(message);
  const bad = (message) => failures.push(message);
  const assert = (condition, message) => (condition ? ok(message) : bad(message));

  // --- Tarball manifest: structural, not string-grep ---
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
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
  // Check engines against the SOURCE manifest, not a hardcoded literal, so changing the supported
  // Node range can't silently diverge between the package and this smoke test.
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
    JSON.stringify(runtimeDeps) === JSON.stringify(EXPECTED_RUNTIME_DEPS),
    `runtime deps match the reviewed allowlist (expected ${EXPECTED_RUNTIME_DEPS.join(",")}; got ${runtimeDeps.join(",")})`,
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

  // P10-T13 #4: Assert published runtime dependency ranges deep-equal the source manifest's.
  // Catches a future drift to `*`/loosened ranges, not just 'typescript is not caret'.
  const sourceDeps = sourceManifest.dependencies ?? {};
  const publishedDeps = manifest.dependencies ?? {};
  assert(
    JSON.stringify(publishedDeps) === JSON.stringify(sourceDeps),
    `published dependencies deep-equal source (${JSON.stringify(publishedDeps)} === ${JSON.stringify(sourceDeps)})`,
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
  // The exact range matters because the build toolchain requires specific Node floors.
  const engineRange = String(manifest.engines?.node ?? "");
  assert(
    engineRange.length > 0,
    `manifest engines.node declares a support range (${manifest.engines?.node})`,
  );
  assert(readme.includes(engineRange), `README declares exact Node support range ${engineRange}`);

  // --- Bundle composition: @fairux/* inlined, typescript/parse5 external, total dist size bounded ---
  const distJs = run("tar", ["-xzOf", tarball, "package/dist/index.js"]);
  assert(
    !/(from|import|require\()\s*["']@fairux\//.test(distJs),
    "dist has no unresolved @fairux/* import/require (inlined)",
  );
  assert(
    /from\s*["']typescript(?:\/[^"']*)?["']/.test(distJs),
    "dist imports typescript externally (not inlined)",
  );
  assert(/from\s*["']parse5["']/.test(distJs), "dist imports parse5 externally (not inlined)");
  assert(
    /from\s*["']commander["']/.test(distJs),
    "dist imports commander externally (not inlined)",
  );
  assert(
    /from\s*["']fast-glob["']/.test(distJs),
    "dist imports fast-glob externally (not inlined)",
  );
  assert(/import\(["']jiti["']\)/.test(distJs), "dist imports jiti externally (not inlined)");
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

  // --- Shared with the SDK: install hooks, and what the archive members actually are -----------
  // Neither was checked here before. `scripts` was never inspected at all, so a `prepack` adding
  // `postinstall` would have shipped it to every consumer; and `tar -tzf` above prints names only,
  // so a symlink named `dist/index.js` reads exactly like the file it replaces.
  const manifestFailures = auditPublishedManifest({ kind: "cli", manifest, sourceManifest });
  assert(
    manifestFailures.length === 0,
    `packed manifest declares no install hooks and matches the checkout${
      manifestFailures.length === 0 ? "" : ` (${manifestFailures.join("; ")})`
    }`,
  );

  const members = readTarMembers(readFileSync(tarball));
  const memberFailures = auditTarMembers(members);
  assert(
    memberFailures.length === 0,
    `every archive member is a regular file under package/${
      memberFailures.length === 0 ? ` (${members.length})` : `: ${memberFailures.join("; ")}`
    }`,
  );

  return failures;
}
