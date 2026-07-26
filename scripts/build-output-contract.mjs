/**
 * Build-output contract — pure path classification.
 *
 * The rule the repository holds itself to: every build artifact lands under a package's `dist/`,
 * and nowhere else. This module decides, from a repo-relative path alone, whether a file breaks
 * that rule. It touches no filesystem, so it can be unit-tested directly (including with Windows
 * separators) while `check-build-output.mjs` supplies the actual file list.
 *
 * Two zones, two strictnesses:
 *
 * - Inside a `src/` tree, nothing generated is tolerated. These directories are hand-written
 *   TypeScript; a `.js` or `.d.ts` appearing there is build output, full stop. This is the zone
 *   issue #57 polluted.
 * - Outside `src/` and outside `dist/`, the repo legitimately checks in `.mjs` scripts and their
 *   hand-authored `.d.mts` ambient declarations, so only unambiguous compiler output is refused.
 */

/** Suffixes that are always build output when they appear inside a `src/` tree. */
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
 * Suffixes that are build output anywhere outside `dist/`.
 *
 * `.mjs` and `.d.mts` are absent on purpose: `packages/*​/scripts/*.mjs` and their checked-in
 * `.d.mts` declarations are sources, not artifacts.
 */
export const STRAY_ARTIFACT_SUFFIXES = Object.freeze([
  ".d.ts.map",
  ".js.map",
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

/** Normalize a path to forward slashes so Windows and POSIX classify identically. */
export function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
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
  // Everything under a `dist/` is build output by definition — that is the point.
  if (segments.includes("dist")) return null;

  if (segments.includes("src")) {
    const suffix = matchSuffix(posixPath, SOURCE_TREE_FORBIDDEN_SUFFIXES);
    return suffix ? { path: posixPath, zone: "source-tree", suffix } : null;
  }

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
 * @returns {string[]} package-relative paths, deduplicated and sorted.
 */
export function declaredTypeEntries(manifest) {
  const entries = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.startsWith("./")) entries.add(value.slice(2));
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
