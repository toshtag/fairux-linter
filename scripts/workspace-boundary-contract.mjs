/**
 * Workspace boundary contract — pure module-specifier analysis.
 *
 * One workspace package must not reach into another's private `src/`. Beyond layering, that import
 * is what triggered issue #57: it pulls a foreign package's sources into this package's declaration
 * program, and tsdown's tsgo generator writes out-of-root declarations next to the source.
 *
 * The first version of this guard matched one shape — `from "../../<pkg>/src/…"` — and counted
 * `../` segments. Review of PR #58 showed four ways past it, all of which reach the TypeScript
 * program just as effectively:
 *
 *   import "../../core/src/index.js";          // side-effect
 *   await import("../../core/src/index.js");   // dynamic
 *   require("../../core/src/index.js");        // CJS, incl. `import x = require(…)`
 *   import { x } from "../../core/src";        // directory, resolves to src/index.ts
 *
 * So the analysis is now two stages: extract every module specifier, then *resolve* it against the
 * importing file and ask whether it lands in another workspace's `src/`. Resolution replaces the
 * `../` counting, so depth no longer matters and same-workspace relative imports stay legal.
 *
 * Deliberately parser-free. This guard runs before the build, and the most reliable guard is the
 * one that cannot itself break; pulling in the TypeScript compiler API — experimental at 7.0 — to
 * read four syntactic forms is not a trade worth making. What a parser buys is comment and string
 * awareness, and {@link stripCommentsAndKeepLayout} provides that with a character scanner rather
 * than a regex: this repository has many `"https://…"` literals, and a naive `//` strip would
 * mangle every one of them.
 *
 * Known limitation: a regular expression *literal* containing an unescaped `//` inside a character
 * class (`/[//]/`) would be read as a comment. No such literal exists here, and the failure mode is
 * a missed detection on that one line rather than a false accusation.
 */

const WORKSPACE_ROOT_PATTERN = /^(?:packages|apps)\/([^/]+)\//;
const WORKSPACE_SOURCE_PATTERN = /^((?:packages|apps)\/[^/]+)\/src(?:\/|$)/;

/** Normalize a path to forward slashes so Windows and POSIX behave identically. */
export function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

/**
 * Blank out comments while preserving every byte offset and line break.
 *
 * Comment characters become spaces rather than disappearing, so line numbers reported against the
 * result still point at the right line of the original file.
 */
export function stripCommentsAndKeepLayout(source) {
  let output = "";
  let state = "code";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line-comment";
        output += "  ";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block-comment";
        output += "  ";
        index += 2;
        continue;
      }
      if (char === "'") state = "single-quote";
      else if (char === '"') state = "double-quote";
      else if (char === "`") state = "template";
      output += char;
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
        output += char;
      } else output += " ";
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        output += "  ";
        index += 2;
      } else {
        output += char === "\n" ? char : " ";
        index += 1;
      }
      continue;
    }

    // Inside a string or template literal: copy through, honouring escapes.
    if (char === "\\") {
      output += char + (next ?? "");
      index += 2;
      continue;
    }
    if (
      (state === "single-quote" && char === "'") ||
      (state === "double-quote" && char === '"') ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
    output += char;
    index += 1;
  }

  return output;
}

/**
 * Every syntactic position that makes TypeScript load another module.
 *
 * `import ... from` and `export ... from` share one pattern; the rest are distinct enough to spell
 * out. `import x = require("…")` is covered by the `require` pattern.
 */
const SPECIFIER_PATTERNS = Object.freeze([
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
]);

/**
 * Extract the module specifiers of a single line of already-comment-stripped source.
 *
 * @returns {string[]} specifiers, in the order they appear.
 */
export function extractModuleSpecifiers(line) {
  const specifiers = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(line);
    while (match !== null) {
      if (match[1]) specifiers.push(match[1]);
      match = pattern.exec(line);
    }
  }
  return specifiers;
}

/** Resolve a relative specifier against the importing file. Returns null for bare specifiers. */
export function resolveRelativeSpecifier(importerPath, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;

  const importerSegments = toPosixPath(importerPath).split("/");
  importerSegments.pop();
  for (const segment of toPosixPath(specifier).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") importerSegments.pop();
    else importerSegments.push(segment);
  }
  return importerSegments.join("/");
}

/** The `packages/<name>` or `apps/<name>` a path belongs to, or null. */
export function workspaceOf(filePath) {
  const match = WORKSPACE_ROOT_PATTERN.exec(toPosixPath(filePath));
  return match ? toPosixPath(filePath).slice(0, match[0].length - 1) : null;
}

/**
 * Decide whether one specifier crosses into another workspace's private source.
 *
 * Same-workspace relative imports are legal at any depth; so is importing a workspace by its
 * package name, which is the whole point of the fix.
 *
 * @returns {{ specifier: string, resolved: string, importerWorkspace: string,
 *   targetWorkspace: string } | null}
 */
export function classifyWorkspacePrivateSourceImport(importerPath, specifier) {
  const resolved = resolveRelativeSpecifier(importerPath, specifier);
  if (resolved === null) return null;

  const target = WORKSPACE_SOURCE_PATTERN.exec(resolved);
  if (!target) return null;

  const importerWorkspace = workspaceOf(importerPath);
  const targetWorkspace = target[1];
  if (importerWorkspace === targetWorkspace) return null;

  return {
    specifier,
    resolved,
    importerWorkspace: importerWorkspace ?? "(outside any workspace)",
    targetWorkspace,
  };
}

/**
 * Audit one source file's text.
 *
 * @returns {Array<{ line: number, specifier: string, resolved: string, targetWorkspace: string }>}
 */
export function auditSourceText(importerPath, sourceText) {
  const violations = [];
  const lines = stripCommentsAndKeepLayout(sourceText).split("\n");

  lines.forEach((line, index) => {
    for (const specifier of extractModuleSpecifiers(line)) {
      const violation = classifyWorkspacePrivateSourceImport(importerPath, specifier);
      if (violation) violations.push({ line: index + 1, ...violation });
    }
  });

  return violations;
}
