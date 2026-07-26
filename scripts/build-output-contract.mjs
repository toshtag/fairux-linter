/**
 * Build-output contract — pure path classification.
 *
 * The rule the repository holds itself to: every build artifact lands under a **direct workspace**
 * `dist/` — `packages/<name>/dist/**` or `apps/<name>/dist/**` — and nowhere else. This module
 * decides, from a repo-relative path alone, whether a file breaks that rule. It touches no
 * filesystem, so it can be unit-tested directly (including with Windows separators) while
 * `check-build-output.mjs` supplies the actual file list.
 *
 * "Direct workspace" is load-bearing, not pedantry. An earlier version allowed any path with a
 * `dist` segment anywhere, which let `packages/core/src/dist/leak.d.ts` and `docs/dist/leak.d.ts`
 * through. That hole was invisible to every other gate too: `.gitignore` ignores `dist/` at any
 * depth, so such a file never appears in `git status --porcelain`, and `biome.json` sets
 * `vcs.useIgnoreFile`, so the post-build lint skips it as well. A leak into a `dist`-named
 * directory would have passed the whole pipeline silently.
 *
 * Zones are matched on anchored prefixes, so they are mutually exclusive and the verdict does not
 * depend on evaluation order:
 *
 * - **Source tree** (`packages|apps|examples`/<name>/`src/**`): nothing generated is tolerated.
 *   These directories are hand-written TypeScript; a `.js` or `.d.ts` appearing there is build
 *   output, full stop. This is the zone issue #57 polluted.
 * - **Workspace dist** (`packages|apps`/<name>/`dist/**`): build output belongs here. Allowed.
 * - **Everything else**: the repo legitimately checks in `.mjs` scripts and their hand-authored
 *   `.d.mts` ambient declarations, so only unambiguous compiler output is refused.
 */

/** Suffixes that are always build output when they appear inside a source tree. */
export const SOURCE_TREE_FORBIDDEN_SUFFIXES = Object.freeze([
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
 * Suffixes that are build output anywhere outside a workspace `dist/`.
 *
 * `.mjs` and `.d.mts` are absent on purpose: `packages/*​/scripts/*.mjs` and their checked-in
 * `.d.mts` declarations are sources, not artifacts. Their **sourcemaps** are not — nothing in this
 * repository hand-writes a `.map`, so every map variant is refused outside `dist/`.
 */
export const STRAY_ARTIFACT_SUFFIXES = Object.freeze([
  ".d.ts.map",
  ".d.mts.map",
  ".d.cts.map",
  ".js.map",
  ".mjs.map",
  ".cjs.map",
  ".d.ts",
  ".tsbuildinfo",
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

/** `packages/<name>/dist/…` or `apps/<name>/dist/…` — the only place build output may land. */
const WORKSPACE_DIST = /^(?:packages|apps)\/[^/]+\/dist(?:\/|$)/;

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

/** True only for a direct workspace `dist/` path — not for any path containing a `dist` segment. */
export function isWorkspaceDistPath(filePath) {
  return WORKSPACE_DIST.test(toPosixPath(filePath));
}

/** True for a workspace source tree path. Mutually exclusive with {@link isWorkspaceDistPath}. */
export function isWorkspaceSourcePath(filePath) {
  return WORKSPACE_SOURCE.test(toPosixPath(filePath));
}

function matchSuffix(posixPath, suffixes) {
  return suffixes.find((suffix) => posixPath.endsWith(suffix)) ?? null;
}

/**
 * Classify one repo-relative path.
 *
 * @returns {{ path: string, zone: "source-tree" | "outside-dist", suffix: string } | null}
 *   a violation, or `null` when the path is allowed.
 */
export function classifyPath(filePath) {
  const posixPath = toPosixPath(filePath);
  const segments = posixPath.split("/");

  if (segments.some((segment) => IGNORED_DIRECTORIES.includes(segment))) return null;

  // Source tree first: `packages/core/src/dist/leak.d.ts` is a source-tree leak, not a build dir.
  if (WORKSPACE_SOURCE.test(posixPath)) {
    const suffix = matchSuffix(posixPath, SOURCE_TREE_FORBIDDEN_SUFFIXES);
    return suffix ? { path: posixPath, zone: "source-tree", suffix } : null;
  }

  if (WORKSPACE_DIST.test(posixPath)) return null;

  const suffix = matchSuffix(posixPath, STRAY_ARTIFACT_SUFFIXES);
  return suffix ? { path: posixPath, zone: "outside-dist", suffix } : null;
}

/**
 * Classify many repo-relative paths, in deterministic order.
 *
 * @returns {Array<{ path: string, zone: string, suffix: string }>}
 */
export function auditPaths(filePaths) {
  const violations = [];
  for (const filePath of filePaths) {
    const violation = classifyPath(filePath);
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
