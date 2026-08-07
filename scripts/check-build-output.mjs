#!/usr/bin/env node
/**
 * Fail-closed build-output invariant.
 *
 * Run this after `pnpm build`. It refuses to pass unless:
 *
 *   1. nothing at all sits below a `dist` directory that is not a real workspace's own output
 *      directory — discovered from `package.json` manifests, not guessed from the path shape — and
 *      no compiler or bundler output sits inside a source tree or anywhere else outside `dist/`;
 *   2. every package that declares `types` points that entry into its own `dist/` and actually
 *      ships the file;
 *   3. `@fairux/sdk` ships every entry point its manifest exports, as both JS and declarations;
 *   4. the CLI still publishes no declarations, which is deliberate — `fairux` is an executable,
 *      not a typed library, and shipping types would imply an API contract we do not offer.
 *
 * Checks 2-4 need a completed build. Deleting `dist/` and re-running is expected to fail; that
 * is the check doing its job, not a false alarm.
 *
 * Fail-closed means the walk fails too. A directory that is simply absent is fine; any other
 * filesystem error (`EACCES`, `EIO`, `EMFILE`) aborts with the offending path rather than being
 * silently treated as "nothing to inspect here".
 *
 * This exists because issue #57 was invisible to every other gate: `pnpm build` wrote 43
 * untracked `*.d.ts` files into `packages/*​/src/` and still exited 0, `pnpm lint` then failed on
 * them, and a release-time write audit would have seen a dirty tree. Deleting the strays
 * afterwards, ignoring them, or hiding them from `files` would all have kept the build broken —
 * so the check asserts where output is *generated*, not what survives cleanup.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sdkEntryPoints } from "../packages/sdk/scripts/sdk-entry-points.mjs";
import {
  auditPaths,
  classifyDeclaredTypeEntry,
  createBuildOutputContext,
  declaredTypeEntries,
  IGNORED_DIRECTORIES,
  isHandwrittenSourceZone,
} from "./build-output-contract.mjs";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOTS = ["packages", "apps"];

/**
 * SDK subpath exports are the published contract, read from the manifest that declares them.
 *
 * This was `["index", "html", "dom"]`. Naming them here made the manifest and this file two places
 * to edit, and the array could only ever be wrong in the direction that matters: a subpath added to
 * `exports` and not here would ship unchecked.
 */
const SDK_ENTRIES = sdkEntryPoints(
  JSON.parse(readFileSync(join(repoRoot, "packages/sdk/package.json"), "utf8")),
).map((entry) => entry.base);

async function collectFiles(absoluteDir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    // An absent directory is a legitimate answer ("nothing built here yet"). Anything else means
    // we did not actually inspect it, and a gate that cannot see a directory must not pass it.
    if (error?.code === "ENOENT") return found;
    throw new Error(
      `Cannot inspect ${relative(repoRoot, absoluteDir) || "."}: ${error?.code ?? "unknown error"}`,
      { cause: error },
    );
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

/**
 * The exact hand-written sources, taken from the Git index.
 *
 * A file counts as hand-written only if the repository already tracks it. Deciding by location
 * alone let an untracked `generated.mjs` dropped into any `scripts/` directory pass as a source,
 * and — because `.gitignore` hides `dist/` at any depth — let `scripts/dist/leak.mjs` pass
 * unnoticed by every other gate too.
 *
 * Failure to read the index is fatal, not an empty set: this runs on a Git checkout as a release
 * gate, and silently treating every source as generated (or as absent) is exactly the fail-open
 * this check exists to prevent.
 */
async function trackedHandwrittenSources() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(
      `Cannot read the Git index in ${repoRoot}: ${error?.message ?? "unknown error"}. ` +
        "pnpm check:build-output identifies hand-written sources from tracked paths and " +
        "will not fall back to trusting the filesystem.",
      { cause: error },
    );
  }
  return stdout.split("\0").filter((file) => file !== "" && isHandwrittenSourceZone(file));
}

const workspaces = await listWorkspaces();
const context = createBuildOutputContext({
  workspaceDirs: workspaces.map((workspace) => workspace.dir),
  trackedHandwrittenSources: await trackedHandwrittenSources(),
});

const failures = [];

// 1. No artifact outside a real workspace `dist/`.
const strayViolations = auditPaths(await collectFiles(repoRoot), context);
if (strayViolations.length > 0) {
  const inSource = strayViolations.filter((violation) => violation.zone === "source-tree");
  const outside = strayViolations.filter((violation) => violation.zone === "outside-dist");
  const describe = (violations) =>
    violations
      .map((violation) => `    ${violation.path}  [${violation.suffix ?? "unauthorized dist/"}]`)
      .join("\n");
  if (inSource.length > 0) {
    failures.push(
      `${inSource.length} build artifact(s) inside a source tree:\n${describe(inSource)}`,
    );
  }
  if (outside.length > 0) {
    failures.push(
      `${outside.length} build artifact(s) outside a real workspace dist/:\n${describe(outside)}`,
    );
  }
}

// 2. Every declared type entry point points into the package's own dist/, and exists.
const misplacedDeclarations = [];
const missingDeclarations = [];
for (const { dir, manifest } of workspaces) {
  for (const entry of declaredTypeEntries(manifest)) {
    const reason = classifyDeclaredTypeEntry(entry);
    if (reason) misplacedDeclarations.push(`${dir} declares "${entry}", which ${reason}`);
    else if (!existsSync(join(repoRoot, dir, entry))) missingDeclarations.push(`${dir}/${entry}`);
  }
}
if (misplacedDeclarations.length > 0) {
  failures.push(
    `${misplacedDeclarations.length} declared type entry point(s) outside dist/:\n` +
      misplacedDeclarations.map((entry) => `    ${entry}`).join("\n"),
  );
}
if (missingDeclarations.length > 0) {
  failures.push(
    `${missingDeclarations.length} declared type entry point(s) missing after build:\n` +
      missingDeclarations.map((entry) => `    ${entry}`).join("\n"),
  );
}

// 3. The SDK ships every published entry point, as JS and as declarations.
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
console.log(
  `  - no build artifacts in a source tree or outside the dist/ of ${workspaces.length} real workspaces`,
);
console.log(
  `  - ${context.trackedHandwrittenSources.size} hand-written sources allowed by tracked path, not by location`,
);
console.log(`  - ${workspaces.length} workspace manifests declare every type entry under dist/`);
console.log(`  - @fairux/sdk ships ${SDK_ENTRIES.length} published entry points (JS + types)`);
console.log("  - fairux CLI publishes no declarations");
