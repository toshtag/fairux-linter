/**
 * Build-output contract — path classification against the repository's real identities.
 *
 * The rule the repository holds itself to: every build artifact lands under a workspace's `dist/`,
 * and nowhere else. This module decides whether a repo-relative path breaks that rule. It touches
 * no filesystem; `check-build-output.mjs` discovers the workspaces and the tracked sources and
 * passes them in as a context, so the classification stays unit-testable — Windows separators
 * included — while still being anchored to what actually exists.
 *
 * Two things must be *identities*, not path shapes, and both were fail-open when they were shapes:
 *
 * - **Which `dist/` is a build directory.** `^(packages|apps)/[^/]+/dist/` accepted
 *   `packages/not-a-workspace/dist/leak.js`. The allowed roots now come from the workspace
 *   manifests `check-build-output.mjs` actually found.
 * - **Which `.mjs`/`.d.mts` is hand-written.** A zone glob accepted
 *   `packages/core/scripts/dist/leak.mjs` and any untracked `generated.mjs` dropped into a
 *   `scripts/` directory. A file now counts as hand-written only when that exact path is already
 *   tracked in the Git index, inside an approved zone, with no `dist` segment.
 *
 * Why this matters more here than it would elsewhere: `.gitignore` ignores `dist/` at any depth and
 * `biome.json` sets `vcs.useIgnoreFile`, so anything leaked into a `dist`-named directory is
 * invisible to `git status --porcelain` and to the post-build lint. This check is the only gate
 * that can see it, so an allowance it grants on shape alone is granted by nothing at all.
 *
 * Zones are matched on anchored prefixes and evaluated in a fixed order: infrastructure we do not
 * police, the source tree, real workspace dist, tracked hand-written source, then anything left
 * that a compiler or bundler could have produced.
 */

/**
 * Every suffix a compiler or bundler produces.
 *
 * One list, not two. An earlier version exempted `.mjs` and `.d.mts` everywhere outside `dist/`,
 * on the grounds that this repository checks some in by hand — which also let
 * `packages/core/test/dist/leak.mjs` and `docs/dist/leak.js` through, invisible to `git status`
 * and to the post-build lint for the same reason a `.d.ts` was. Hand-written sources are now
 * allowed by *location* instead; see {@link HANDWRITTEN_SOURCE_PATTERNS}.
 *
 * Ordered longest-first so `.d.ts.map` is never reported as `.d.ts`; a unit test pins that.
 */
export const CODE_ARTIFACT_SUFFIXES = Object.freeze([
  ".d.ts.map",
  ".d.mts.map",
  ".d.cts.map",
  ".js.map",
  ".mjs.map",
  ".cjs.map",
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".tsbuildinfo",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);

/**
 * The only locations where this repository keeps hand-written `.mjs` and `.d.mts` files.
 *
 * Derived from what is actually checked in: every tracked runtime/declaration source lives in a
 * `scripts/` directory or under `tests/fixtures/`. Nothing hand-written uses `.js`, `.cjs`,
 * `.jsx`, or `.d.cts`, so those are artifacts wherever they appear outside a workspace `dist/`.
 *
 * These are a *filter* on the Git index, not an allowance on their own — see
 * {@link createBuildOutputContext}. Location alone let `packages/core/scripts/dist/leak.mjs` and
 * an untracked `generated.mjs` through.
 */
export const HANDWRITTEN_SOURCE_ZONES = Object.freeze([
  /^scripts\/[^/]+\.(?:mjs|d\.mts)$/,
  /^(?:packages|apps)\/[^/]+\/scripts\/.+\.(?:mjs|d\.mts)$/,
  /^tests\/fixtures\/.+\.mjs$/,
]);

/** Directories never worth walking; their contents are not ours to police. */
export const IGNORED_DIRECTORIES = Object.freeze([
  ".git",
  ".code-pact",
  ".context",
  ".local",
  ".turbo",
  "coverage",
  "node_modules",
]);

/**
 * `packages|apps|examples/<name>/src/…` — hand-written source.
 *
 * `examples` is included because the authoring example is a template external authors copy; a
 * stray artifact there ships bad advice.
 */
const WORKSPACE_SOURCE = /^(?:packages|apps|examples)\/[^/]+\/src(?:\/|$)/;

/** Normalize a path to forward slashes so Windows and POSIX classify identically. */
export function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

/**
 * Bind the classification to the repository's real identities.
 *
 * @param {object} input
 * @param {Iterable<string>} input.workspaceDirs
 *   Workspace directories discovered from `package.json` manifests, e.g. `packages/core`. Only
 *   these get a build directory; `packages/not-a-workspace/dist/` is not one.
 * @param {Iterable<string>} input.trackedHandwrittenSources
 *   Exact repo-relative paths, already tracked in the Git index, that are hand-written sources.
 *   Anything not in this set is treated as generated, whatever its extension or directory.
 */
export function createBuildOutputContext({ workspaceDirs, trackedHandwrittenSources }) {
  return Object.freeze({
    workspaceDirs: new Set([...workspaceDirs].map(toPosixPath)),
    trackedHandwrittenSources: new Set([...trackedHandwrittenSources].map(toPosixPath)),
  });
}

/** True for a path inside an approved hand-written source zone, with no `dist` segment. */
export function isHandwrittenSourceZone(filePath) {
  const posixPath = toPosixPath(filePath);
  if (posixPath.split("/").includes("dist")) return false;
  return HANDWRITTEN_SOURCE_ZONES.some((zone) => zone.test(posixPath));
}

/** True only for the `dist/` of a workspace that actually exists. */
export function isWorkspaceDistPath(filePath, context) {
  const posixPath = toPosixPath(filePath);
  const segments = posixPath.split("/");
  if (segments.length < 3 || segments[2] !== "dist") return false;
  return context.workspaceDirs.has(`${segments[0]}/${segments[1]}`);
}

/** True for a workspace source tree path. Mutually exclusive with {@link isWorkspaceDistPath}. */
export function isWorkspaceSourcePath(filePath) {
  return WORKSPACE_SOURCE.test(toPosixPath(filePath));
}

/** True only when this exact path is a tracked hand-written source in an approved zone. */
export function isHandwrittenSourcePath(filePath, context) {
  const posixPath = toPosixPath(filePath);
  return isHandwrittenSourceZone(posixPath) && context.trackedHandwrittenSources.has(posixPath);
}

function matchSuffix(posixPath, suffixes) {
  return suffixes.find((suffix) => posixPath.endsWith(suffix)) ?? null;
}

/**
 * Classify one repo-relative path against a {@link createBuildOutputContext} context.
 *
 * The context is required rather than optional. A default would have to be either permissive
 * (fail-open, the bug this closes) or empty (rejecting the repository's own sources), and neither
 * is a sane thing to get by forgetting an argument.
 *
 * @returns {{ path: string, zone: "source-tree" | "outside-dist", suffix: string } | null}
 *   a violation, or `null` when the path is allowed.
 */
export function classifyPath(filePath, context) {
  const posixPath = toPosixPath(filePath);
  const segments = posixPath.split("/");

  if (segments.some((segment) => IGNORED_DIRECTORIES.includes(segment))) return null;

  // Source tree first: `packages/core/src/dist/leak.d.ts` is a source leak, not a build directory.
  if (WORKSPACE_SOURCE.test(posixPath)) {
    const suffix = matchSuffix(posixPath, CODE_ARTIFACT_SUFFIXES);
    return suffix ? { path: posixPath, zone: "source-tree", suffix } : null;
  }

  if (isWorkspaceDistPath(posixPath, context)) return null;
  if (isHandwrittenSourcePath(posixPath, context)) return null;

  const suffix = matchSuffix(posixPath, CODE_ARTIFACT_SUFFIXES);
  return suffix ? { path: posixPath, zone: "outside-dist", suffix } : null;
}

/**
 * Classify many repo-relative paths, in deterministic order.
 *
 * @returns {Array<{ path: string, zone: string, suffix: string }>}
 */
export function auditPaths(filePaths, context) {
  const violations = [];
  for (const filePath of filePaths) {
    const violation = classifyPath(filePath, context);
    if (violation) violations.push(violation);
  }
  return violations.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Collect the declared type entry points of a package manifest.
 *
 * A package that promises `types` in `package.json` or in any `exports` condition must actually
 * ship that file after a build; otherwise the tarball type-resolves to nothing for consumers.
 *
 * Values are returned package-relative and normalized, whether or not they carried a `./` prefix —
 * dropping un-prefixed values would silently exempt them from every check below.
 *
 * @returns {string[]} package-relative paths, deduplicated and sorted.
 */
export function declaredTypeEntries(manifest) {
  const entries = new Set();
  const add = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    entries.add(toPosixPath(value).replace(/^\.\//, ""));
  };

  add(manifest.types);
  add(manifest.typings);

  const walkExports = (node) => {
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "types") add(value);
      else walkExports(value);
    }
  };
  walkExports(manifest.exports);

  return [...entries].sort();
}

/**
 * A declared type entry must point into the package's own `dist/`.
 *
 * Publishing `./src/index.d.ts` would make the package's public types depend on a directory that
 * is not built, may not be packed, and — before P20-T3 — was being written into by the build.
 *
 * @returns {string | null} the reason it is invalid, or `null` when it is fine.
 */
export function classifyDeclaredTypeEntry(entry) {
  const normalized = toPosixPath(entry).replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) return "escapes the package directory";
  if (!/^dist\//.test(normalized)) return "is not under dist/";
  return null;
}
