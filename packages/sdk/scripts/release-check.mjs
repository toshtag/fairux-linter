#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditPublishedManifest,
  auditTarMembers,
} from "../../../scripts/packed-publish-contract.mjs";
import { PUBLIC_NPM_REGISTRY } from "../../../scripts/public-npm-registry.mjs";
import { staticImportSpecifiers } from "../../../scripts/static-module-imports.mjs";
import { readTarMembers } from "../../../scripts/tar-members.mjs";
import { workspaceVersions } from "../../../scripts/workspace-versions.mjs";
import { getNpmRegistryState } from "./npm-registry-state.mjs";
import { auditSourceMap } from "./source-map-audit.mjs";

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sdkDir, "..", "..");
const sourceManifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
const tagArgIndex = process.argv.indexOf("--tag");
const tag =
  tagArgIndex >= 0 ? process.argv[tagArgIndex + 1] : (process.env.GITHUB_REF_NAME ?? undefined);
const expectedTag = `sdk-v${sourceManifest.version}`;
const allowedFiles = ["dist", "README.md", "LICENSE", "NOTICE"];
const requiredExports = [".", "./html", "./dom", "./package.json"];
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^node:/, "")),
  ...builtinModules.map((name) => `node:${name.replace(/^node:/, "")}`),
]);

let failed = false;
const ok = (message) => console.log(`✓ ${message}`);
const bad = (message) => {
  console.error(`✗ ${message}`);
  failed = true;
};
const assert = (condition, message) => (condition ? ok(message) : bad(message));

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function tarText(tarball, entry) {
  return run("tar", ["-xzOf", tarball, `package/${entry}`]);
}

function assertNoWorkspaceSpecifiers(manifest, label) {
  const dependencyMaps = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  for (const mapName of dependencyMaps) {
    const map = manifest[mapName] ?? {};
    for (const [name, range] of Object.entries(map)) {
      assert(
        !String(range).includes("workspace:"),
        `${label} ${mapName}.${name} has no workspace:`,
      );
    }
  }
}

assert(sourceManifest.name === "@fairux/sdk", "SDK package name is @fairux/sdk");
assert(sourceManifest.private === false, "SDK package is public");
assert(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(sourceManifest.version),
  `SDK version is semver (${sourceManifest.version})`,
);
assert(sourceManifest.publishConfig?.access === "public", "publishConfig.access is public");
assert(
  sourceManifest.engines?.node === "^22.18.0 || >=24.11.0",
  "SDK Node support range is the reviewed beta range",
);
assert(
  JSON.stringify(sourceManifest.files ?? []) === JSON.stringify(allowedFiles),
  "SDK files whitelist is dist, README, LICENSE, NOTICE",
);
for (const exportKey of requiredExports) {
  assert(Boolean(sourceManifest.exports?.[exportKey]), `SDK export ${exportKey} is declared`);
}
assert(
  sourceManifest.scripts?.prepublishOnly === "node scripts/prepublish-guard.mjs",
  "SDK source package keeps the prepublish guard",
);
assertNoWorkspaceSpecifiers(
  {
    dependencies: sourceManifest.dependencies,
    optionalDependencies: sourceManifest.optionalDependencies,
    peerDependencies: sourceManifest.peerDependencies,
  },
  "source runtime manifest",
);

if (tag !== undefined) {
  assert(tag === expectedTag, `SDK tag ${tag} matches packages/sdk/package.json (${expectedTag})`);
  const version = tag.replace(/^sdk-v/, "");
  assert(version === sourceManifest.version, "SDK tag version uses the SDK package version");
  assert(version.includes("-"), "P20 SDK release workflow is beta-only");
  const distTag = "next";
  assert(distTag === "next", `prerelease SDK will publish with npm dist-tag ${distTag}`);
}

const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
assert(
  changelog.includes(sourceManifest.version) || changelog.includes("First public release"),
  "CHANGELOG mentions the SDK beta version or first public release section",
);
const status = readFileSync(join(repoRoot, "docs", "status.md"), "utf8");
assert(
  status.includes(`@fairux/sdk@${sourceManifest.version}`) &&
    status.includes("has not been published to npm"),
  "status docs do not claim registry publication before release",
);

const workflow = readFileSync(join(repoRoot, ".github", "workflows", "publish-sdk.yml"), "utf8");
assert(workflow.includes('"sdk-v*"'), "SDK publish workflow is triggered only by sdk-v* tags");
assert(
  workflow.includes("packages/sdk/package.json"),
  "SDK workflow reads packages/sdk/package.json",
);
assert(
  !workflow.includes("apps/cli/package.json"),
  "SDK workflow does not read the CLI package version",
);
// Assert the flags, not one exact line: the publish command is wrapped across lines so the
// registry is readable next to them. A substring match on the joined form would break on
// reformatting while silently accepting a dropped flag.
const publishCommand = workflow.slice(workflow.indexOf("npm publish"));
for (const flag of [
  "--ignore-scripts",
  "--provenance",
  "--access public",
  // Named here because the publish job deliberately gives `actions/setup-node` no `registry-url`:
  // that writes an unresolved ${NODE_AUTH_TOKEN} placeholder, which suppresses the OIDC exchange
  // and cost the sdk-v0.1.0-beta.1 tag (run 30233771956).
  `--registry=${PUBLIC_NPM_REGISTRY}`,
]) {
  assert(publishCommand.includes(flag), `SDK workflow publishes with ${flag}`);
}
assert(
  !/registry-url:/.test(workflow),
  "SDK workflow gives setup-node no registry-url (it would suppress OIDC)",
);

if (process.env.TARBALL) {
  const tarball = resolve(process.env.TARBALL);
  assert(existsSync(tarball), `TARBALL exists (${tarball})`);
  // --- Paths first. Nothing is read out of this archive until its member list is unambiguous ----
  // `tar -xzOf <path>` concatenates every member with that path, so a duplicate `dist/dom.js` whose
  // first copy is `//` hands the auditor a comment while extraction keeps the second copy. Reading
  // content from an archive whose paths have not verified is the bug, not the checks that follow.
  const members = readTarMembers(readFileSync(tarball));
  const memberAudit = auditTarMembers(members);
  for (const failure of memberAudit.failures) bad(failure);
  if (memberAudit.failures.length > 0) {
    console.log("\n✗ SDK release check FAILED (ambiguous archive; payload not inspected)");
    process.exit(1);
  }
  ok(
    `every archive member is a unique, canonical, regular file under package/ (${members.length})`,
  );

  const packedManifest = JSON.parse(tarText(tarball, "package.json"));
  assert(packedManifest.name === sourceManifest.name, "packed manifest name matches source");
  assert(
    packedManifest.version === sourceManifest.version,
    "packed manifest version matches source",
  );
  assert(packedManifest.private !== true, "packed manifest is public");
  assertNoWorkspaceSpecifiers(packedManifest, "packed manifest");

  // Derived from the verified headers, not from a second `tar -tzf` listing that could disagree.
  const entries = memberAudit.names;
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/html.js",
    "dist/html.d.ts",
    "dist/dom.js",
    "dist/dom.d.ts",
    "README.md",
    "LICENSE",
    "NOTICE",
    "package.json",
  ]) {
    assert(entries.includes(required), `packed tarball contains ${required}`);
  }
  const unexpected = entries.filter(
    (entry) => !/^(package\.json|README\.md|LICENSE|NOTICE|dist\/.*)$/.test(entry),
  );
  assert(unexpected.length === 0, `packed tarball has no private source or fixtures`);
  assert(!entries.some((entry) => entry.includes(".env")), "packed tarball has no .env payload");
  assert(
    !entries.some((entry) => /(^|\/)test(s)?\//.test(entry)),
    "packed tarball has no test fixtures",
  );

  const joinedDist = entries
    .filter((entry) => /^dist\/.*\.(js|d\.ts)$/.test(entry))
    .map((entry) => tarText(tarball, entry))
    .join("\n");
  const sourceMaps = entries.filter((entry) => /^dist\/.*\.map$/.test(entry));
  for (const sourceMap of sourceMaps) {
    const errors = auditSourceMap(sourceMap, tarText(tarball, sourceMap), { repoRoot });
    for (const error of errors) bad(error);
  }
  assert(sourceMaps.length === 0, "SDK beta tarball does not publish source maps");
  assert(!joinedDist.includes("packages/"), "packed dist has no source-tree path imports");
  assert(!joinedDist.includes("workspace:"), "packed dist has no workspace specifier");
  assert(!/from ["']@fairux\//.test(joinedDist), "packed dist has no internal @fairux imports");
  // --- The browser entry's *static* module requests, via Node's own parser ---------------------
  // This is the part the privileged job can establish without a dependency tree: `SourceTextModule`
  // reports a module's static specifiers exactly, with no hand-written parsing involved.
  //
  // Runtime module loads — dynamic `import()`, bare `require()` — are NOT checked here. They need a
  // JavaScript parser, and writing one out of Node built-ins so it could run in this job produced a
  // scanner whose own comment was wrong about template literals. That check now runs in the
  // unprivileged prepare job and PR CI, with the installed TypeScript parser, in
  // `audit-browser-module.mjs`. This job verifies the structural release contract and publishes the
  // exact verified bytes without executing them; it does not claim to prove what they do.
  const domImports = staticImportSpecifiers(tarText(tarball, "dist/dom.js")).filter((specifier) =>
    nodeBuiltins.has(specifier),
  );
  assert(domImports.length === 0, "browser DOM entry has no static Node builtin imports");

  // --- The packed manifest must be the checkout's, in full -------------------------------------
  const manifestFailures = auditPublishedManifest({
    manifest: packedManifest,
    sourceManifest,
    workspaceVersions: workspaceVersions(repoRoot),
  });
  for (const failure of manifestFailures) bad(failure);
  if (manifestFailures.length === 0) {
    ok("packed manifest declares no install hooks and equals the checkout's, field for field");
  }
}

if (process.env.FAIRUX_RELEASE_CHECK_NPM === "1") {
  const state = getNpmRegistryState(`${sourceManifest.name}@${sourceManifest.version}`);
  if (state.status === "absent") {
    ok("npm registry reports the target SDK version is absent");
  } else if (state.status === "present") {
    bad(`target SDK version is already published: ${sourceManifest.name}@${state.version}`);
  } else {
    bad(`npm registry state is unavailable: ${state.reason}`);
  }
}

console.log(failed ? "\n✗ SDK release check FAILED" : "\n✓ SDK release check passed");
process.exitCode = failed ? 1 : 0;
