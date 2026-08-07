/**
 * Structural contract for the packed `fairux` tarball.
 *
 * Extracted from `pack-smoke-test.mjs` so the **privileged publish job can re-run it**. That job
 * receives a tarball built by an unprivileged job that ran lifecycle scripts, so matching digests
 * only prove the bundle is self-consistent — a lifecycle script that rewrote the tarball and then
 * rewrote the metadata to match would pass identity checks. These assertions look inside the bytes
 * instead, using the auditor from the clean tagged checkout.
 *
 * Everything here works from Node built-ins alone: no `npm install`, no CLI execution, no network,
 * and — since M1-R3 — no external `tar`, `sh`, `grep`, or `wc` either. Those were not portable:
 * `tar -xzOf` and a `sh -c` pipeline do not exist in the same form on a Windows runner, so the
 * audit that guards the publish ran only on the Linux CI target and could not run on the Windows
 * target M1-R3 requires. Reading the archive through `readTarArchive` also removes a subtler
 * problem: the
 * external reader decompressed the archive a second time, independently of the header audit above
 * it. The install-and-run half of the smoke test stays where it was, in the unprivileged job.
 */
import { readFileSync } from "node:fs";
import {
  auditPublishedManifest,
  auditTarMembers,
} from "../../../scripts/packed-publish-contract.mjs";
import { readTarArchive } from "../../../scripts/tar-members.mjs";
import { workspaceVersions } from "../../../scripts/workspace-versions.mjs";
import { auditCliSourceMap } from "./source-map-audit.mjs";

const MAX_TARBALL_DIST_BYTES = 2 * 1024 * 1024; // dist must stay small (typescript must NOT be inlined)
const EXPECTED_RUNTIME_DEPS = ["commander", "fast-glob", "jiti", "parse5", "typescript"];

/**
 * @param {object} input
 * @param {string} input.tarball  path to the packed tarball
 * @param {string} input.sourceManifestPath  `apps/cli/package.json` from the trusted checkout
 * @param {string} input.repoRoot  the trusted checkout, for resolving workspace versions
 * @param {(message: string) => void} [input.onPass]
 * @returns {string[]} failures; empty means the tarball satisfies the contract
 */
export function auditPackedCliTarball({
  tarball,
  sourceManifestPath,
  repoRoot,
  onPass = () => {},
}) {
  const failures = [];
  const ok = (message) => onPass(message);
  const bad = (message) => failures.push(message);
  const assert = (condition, message) => (condition ? ok(message) : bad(message));

  // --- Paths first. Nothing is read out of this archive until its member list is unambiguous ----
  // A duplicate or a `.`-segment alias lets a reader and an extractor see different bytes: the
  // extractor keeps the last member with that path. Reproduced against the real SDK tarball; the
  // CLI's archive has the same shape. `readBody` refuses an ambiguous name outright, and this
  // audit runs first so no name reaches it that the member list has not already settled.
  const archive = readTarArchive(readFileSync(tarball));
  const members = archive.members;
  const memberAudit = auditTarMembers(members);
  if (memberAudit.failures.length > 0) {
    return memberAudit.failures;
  }
  ok(
    `every archive member is a unique, canonical, regular file under package/ (${members.length})`,
  );

  /** Read a verified member, named relative to `package/`, as UTF-8 text. */
  const readText = (name) => archive.readBody(`package/${name}`).toString("utf8");

  // --- Tarball manifest: structural, not string-grep ---
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
  const manifest = JSON.parse(readText("package.json"));
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
  // Derived from the verified headers, not a second `tar -tzf` listing that could disagree.
  const entries = memberAudit.names;
  for (const required of ["dist/index.js", "README.md", "LICENSE", "NOTICE", "package.json"]) {
    assert(entries.includes(required), `tarball contains ${required}`);
  }
  const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|dist\/.*)$/;
  const unexpected = entries.filter((e) => !ALLOWED.test(e));
  assert(
    unexpected.length === 0,
    `tarball contains only allowed paths (unexpected: ${unexpected.join(",") || "none"})`,
  );

  // --- Source maps: audited here, in the tarball, not in the workspace ------------------------
  // `dist/.*` in the allowlist above admits any map the build emits, and the published map is the
  // one artifact whose *contents* the file list says nothing about. Auditing `apps/cli/dist` after
  // a local build would check a file that a later pack step could still change; these are the
  // bytes that ship. The maps are named from the verified member list, so a build that starts
  // emitting a second chunk brings its map into the audit without an edit here.
  const maps = entries.filter((entry) => entry.endsWith(".map"));
  assert(maps.length > 0, "tarball ships at least one source map for the published bundle");
  for (const map of maps) {
    const failures = auditCliSourceMap(
      map,
      readText(map),
      // The map's own location inside the package, which is where its relative `sources` are
      // anchored — `apps/cli/dist` in the repository, `dist` in the tarball. Passing the
      // repository-relative directory keeps "does this escape the repository?" answerable.
      { mapDir: `apps/cli/${map.slice(0, map.lastIndexOf("/"))}` },
    );
    for (const failure of failures) bad(failure);
    if (failures.length === 0) ok(`${map} publishes paths and mappings, not embedded source`);
  }

  // --- README is the package-specific one, not the repo-root dev README ---
  const readme = readText("README.md");
  // `npx fairux scan` or `npx fairux@<channel> scan`. The bare form was required literally, and
  // while `latest` names the deprecated `0.0.0-bootstrap.0` placeholder it is a command that
  // installs a name reservation — so the README's quick start was a command a reader could not use,
  // and the contract required it to stay that way. What has to hold is that an npm user is given a
  // one-line start; which channel it names is a fact about what is published, and the release
  // that moves `latest` is the one that makes the bare form correct again.
  assert(
    /npx fairux(@[0-9A-Za-z.-]+)? scan/.test(readme),
    "README has npm-user quick start (npx fairux [@channel] scan)",
  );
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
  const distJs = readText("dist/index.js");
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
  // Sum ALL dist/ entries (not just index.js) so a bloated sourcemap can't slip through. The sizes
  // come from the headers this audit already verified, so the total describes the same members the
  // allowlist above accepted — a `tar | grep | wc` pipeline re-listed the archive and could have
  // been answering about a different set.
  const distBytes = members
    .filter((member) => member.name.startsWith("package/dist/"))
    .reduce((total, member) => total + member.size, 0);
  assert(
    distBytes > 0 && distBytes < MAX_TARBALL_DIST_BYTES,
    `total dist/ under ${MAX_TARBALL_DIST_BYTES} bytes (${distBytes})`,
  );

  // --- Shared with the SDK: the packed manifest must be the checkout's, in full ----------------
  // `scripts` was never inspected here at all, so a `prepack` adding `postinstall` would have
  // shipped it to every consumer. Comparing a hand-picked list of fields left every other field
  // free — `os`, `cpu`, `libc`, `bundleDependencies` — so this is a whole-object comparison.
  const manifestFailures = auditPublishedManifest({
    manifest,
    sourceManifest,
    workspaceVersions: workspaceVersions(repoRoot),
  });
  for (const failure of manifestFailures) bad(failure);
  if (manifestFailures.length === 0) {
    ok("packed manifest declares no install hooks and equals the checkout's, field for field");
  }

  return failures;
}
