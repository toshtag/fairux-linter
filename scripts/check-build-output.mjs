#!/usr/bin/env node
/**
 * Fail-closed build-output invariant.
 *
 * Run this after `pnpm build`. It refuses to pass unless:
 *
 *   1. no build artifact sits inside any `src/` tree, or anywhere outside a package `dist/`;
 *   2. every package that declares `types` actually ships that declaration file;
 *   3. `@fairux/sdk` ships its three published entry points as both JS and declarations;
 *   4. the CLI still publishes no declarations, which is deliberate — `fairux` is an executable,
 *      not a typed library, and shipping types would imply an API contract we do not offer.
 *
 * Checks 2-4 need a completed build. Deleting `dist/` and re-running is expected to fail; that
 * is the check doing its job, not a false alarm.
 *
 * This exists because issue #57 was invisible to every other gate: `pnpm build` wrote 43
 * untracked `*.d.ts` files into `packages/*​/src/` and still exited 0, `pnpm lint` then failed on
 * them, and a release-time write audit would have seen a dirty tree. Deleting the strays
 * afterwards, ignoring them, or hiding them from `files` would all have kept the build broken —
 * so the check asserts where output is *generated*, not what survives cleanup.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPaths, declaredTypeEntries, IGNORED_DIRECTORIES } from "./build-output-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOTS = ["packages", "apps"];

/** SDK subpath exports are the published contract; assert them by name, not by inference. */
const SDK_ENTRIES = ["index", "html", "dom"];

async function collectFiles(absoluteDir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.includes(entry.name)) continue;
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectFiles(absolutePath)));
    else if (entry.isFile()) found.push(relative(repoRoot, absolutePath));
  }
  return found;
}

async function readManifest(absolutePath) {
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

async function listWorkspaces() {
  const workspaces = [];
  for (const root of WORKSPACE_ROOTS) {
    const absoluteRoot = join(repoRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(absoluteRoot, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      workspaces.push({
        dir: `${root}/${entry.name}`,
        manifest: await readManifest(manifestPath),
      });
    }
  }
  return workspaces.sort((a, b) => a.dir.localeCompare(b.dir));
}

const failures = [];

// 1. No artifact outside a package `dist/`.
const strayViolations = auditPaths(await collectFiles(repoRoot));
if (strayViolations.length > 0) {
  const inSource = strayViolations.filter((violation) => violation.zone === "source-tree");
  const outside = strayViolations.filter((violation) => violation.zone === "outside-dist");
  const describe = (violations) =>
    violations.map((violation) => `    ${violation.path}  [${violation.suffix}]`).join("\n");
  if (inSource.length > 0) {
    failures.push(
      `${inSource.length} build artifact(s) inside a source tree:\n${describe(inSource)}`,
    );
  }
  if (outside.length > 0) {
    failures.push(
      `${outside.length} build artifact(s) outside any package dist/:\n${describe(outside)}`,
    );
  }
}

const workspaces = await listWorkspaces();

// 2. Every declared type entry point exists.
const missingDeclarations = [];
for (const { dir, manifest } of workspaces) {
  for (const entry of declaredTypeEntries(manifest)) {
    if (!existsSync(join(repoRoot, dir, entry))) missingDeclarations.push(`${dir}/${entry}`);
  }
}
if (missingDeclarations.length > 0) {
  failures.push(
    `${missingDeclarations.length} declared type entry point(s) missing after build:\n` +
      missingDeclarations.map((entry) => `    ${entry}`).join("\n"),
  );
}

// 3. The SDK ships all three published entry points, as JS and as declarations.
const missingSdkEntries = SDK_ENTRIES.flatMap((entry) =>
  [`packages/sdk/dist/${entry}.js`, `packages/sdk/dist/${entry}.d.ts`].filter(
    (candidate) => !existsSync(join(repoRoot, candidate)),
  ),
);
if (missingSdkEntries.length > 0) {
  failures.push(
    `${missingSdkEntries.length} published SDK entry point artifact(s) missing:\n` +
      missingSdkEntries.map((entry) => `    ${entry}`).join("\n"),
  );
}

// 4. The CLI still publishes no declarations.
const cliDist = join(repoRoot, "apps/cli/dist");
if (!existsSync(cliDist)) {
  failures.push("apps/cli/dist is missing — run pnpm build before pnpm check:build-output.");
} else {
  const cliDeclarations = (await collectFiles(cliDist)).filter((file) =>
    /\.d\.[cm]?ts$/.test(file),
  );
  if (cliDeclarations.length > 0) {
    failures.push(
      `The CLI must not publish declarations, but ${cliDeclarations.length} were emitted:\n` +
        cliDeclarations.map((file) => `    ${file}`).join("\n"),
    );
  }
}

if (failures.length > 0) {
  console.error("✖ Build output contract violated:\n");
  console.error(failures.map((failure) => `  ${failure}`).join("\n\n"));
  console.error(
    "\nFix where the output is generated, not after the fact. Deleting the files, ignoring" +
      "\nthem, or excluding them from lint leaves the build non-idempotent.",
  );
  process.exit(1);
}

console.log("✓ Build output contract passed:");
console.log("  - no build artifacts in any source tree or outside a package dist/");
console.log(`  - ${workspaces.length} workspace manifests ship every declared type entry point`);
console.log(`  - @fairux/sdk ships ${SDK_ENTRIES.length} published entry points (JS + types)`);
console.log("  - fairux CLI publishes no declarations");
