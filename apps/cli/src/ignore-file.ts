import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

/**
 * `.fairuxignore` — which paths a directory walk or a glob may reach.
 *
 * The grammar is a deliberately small subset of gitignore's, and both halves of that are written
 * down here and in the CLI README. A pattern that silently matches nothing is worse than one that is
 * rejected, so the unsupported constructs are named rather than left to be discovered.
 *
 * **Supported:** `#` comments, blank lines, `*` (any run of characters except `/`), `?` (one
 * character except `/`), `**` (any number of path segments), a leading `/` anchoring to the ignore
 * file's directory, a trailing `/` restricting a pattern to directories, and `!` negation with
 * last-match-wins.
 *
 * **Not supported:** character classes (`[a-z]`), backslash escaping, and per-directory nested
 * ignore files. A pattern containing `[` or `\` is refused when the file is read, rather than
 * matched approximately.
 *
 * One file, one base. Git resolves nested ignore files per directory; doing that here would make
 * "why was this file skipped" a question with several possible answers, and this is a linter's scan
 * scope rather than a version control system's.
 */

export const IGNORE_FILE_NAME = ".fairuxignore";

/** Thrown when an ignore file contains a construct this matcher will not approximate. */
export class IgnoreFileError extends Error {
  constructor(filePath: string, line: number, reason: string) {
    super(`${filePath}:${line}: ${reason}`);
    this.name = "IgnoreFileError";
  }
}

interface IgnoreRule {
  readonly source: string;
  readonly negated: boolean;
  readonly matcher: RegExp;
  /**
   * For a `dir/` pattern, the form that matches a path *inside* the directory.
   *
   * `dir/` excludes the directory and everything under it. A walk gets that by pruning at the
   * directory, but a glob yields files and never offers the directory at all — so without this a
   * `dist/` pattern excluded nothing from `fairux scan "**\/*.html"`. Absent for patterns that are
   * not directory-only, where `matcher` already covers both.
   */
  readonly insideMatcher?: RegExp;
}

export interface IgnoreMatcher {
  /** Absolute path of the file the rules came from, or `undefined` when none was found. */
  readonly filePath?: string;
  /** Directory the patterns are relative to. */
  readonly baseDir: string;
  /** Whether an absolute path is excluded. `isDirectory` selects directory-only patterns. */
  readonly ignores: (absolutePath: string, isDirectory?: boolean) => boolean;
  /** Patterns that matched nothing during this run — reported, never silently accepted. */
  readonly unusedPatterns: () => readonly string[];
}

/**
 * Translate one pattern into an anchored regular expression.
 *
 * `**` is handled before `*` so `**\/` collapses to "any number of leading segments" rather than
 * two single-segment wildcards, which is the difference between `**\/dist` matching `a/b/dist` and
 * matching nothing.
 */
function patternToRegExpSource(
  pattern: string,
  anchored: boolean,
): { prefix: string; body: string } {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const rest = pattern.slice(index);
    if (rest.startsWith("**/")) {
      source += "(?:[^/]+/)*";
      index += 3;
    } else if (rest.startsWith("**")) {
      source += ".*";
      index += 2;
    } else {
      const character = pattern[index] ?? "";
      if (character === "*") source += "[^/]*";
      else if (character === "?") source += "[^/]";
      else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      index += 1;
    }
  }
  // Unanchored patterns match at any depth, the way a bare `dist` does in gitignore. Anchored ones
  // are pinned to the ignore file's directory.
  return { prefix: anchored ? "^" : "^(?:.*/)?", body: source };
}

/**
 * A match on a directory also covers everything under it: excluding `dist` has to exclude
 * `dist/index.html`, which is the only reason anyone writes it.
 */
function patternToRegExp(pattern: string, anchored: boolean): RegExp {
  const { prefix, body } = patternToRegExpSource(pattern, anchored);
  return new RegExp(`${prefix}${body}(?:/.*)?$`);
}

/** The same pattern, requiring at least one segment after it — "strictly inside this directory". */
function patternToInsideRegExp(pattern: string, anchored: boolean): RegExp {
  const { prefix, body } = patternToRegExpSource(pattern, anchored);
  return new RegExp(`${prefix}${body}/.+$`);
}

function parseLine(raw: string, filePath: string, lineNumber: number): IgnoreRule | undefined {
  const line = raw.replace(/\r$/, "").trim();
  if (line === "" || line.startsWith("#")) return undefined;

  const negated = line.startsWith("!");
  let pattern = negated ? line.slice(1) : line;
  if (pattern === "") {
    throw new IgnoreFileError(filePath, lineNumber, "a `!` with no pattern excludes nothing");
  }
  if (/[[\]\\]/.test(pattern)) {
    throw new IgnoreFileError(
      filePath,
      lineNumber,
      "character classes and backslash escapes are not supported; use `*`, `?`, or `**`",
    );
  }

  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  if (pattern === "") {
    throw new IgnoreFileError(filePath, lineNumber, "an empty pattern excludes nothing");
  }

  const isAnchored = anchored || pattern.includes("/");
  return {
    source: line,
    negated,
    matcher: patternToRegExp(pattern, isAnchored),
    ...(directoryOnly ? { insideMatcher: patternToInsideRegExp(pattern, isAnchored) } : {}),
  };
}

/** A matcher that excludes nothing, for `--no-ignore` and for a base with no ignore file. */
export function noIgnore(baseDir: string): IgnoreMatcher {
  return {
    baseDir,
    ignores: () => false,
    unusedPatterns: () => [],
  };
}

export function parseIgnoreFile(contents: string, filePath: string): IgnoreRule[] {
  return contents
    .split("\n")
    .map((line, index) => parseLine(line, filePath, index + 1))
    .filter((rule): rule is IgnoreRule => rule !== undefined);
}

function createMatcher(baseDir: string, rules: IgnoreRule[], filePath?: string): IgnoreMatcher {
  const used = new Set<string>();
  return {
    ...(filePath ? { filePath } : {}),
    baseDir,
    ignores(absolutePath: string, isDirectory = false): boolean {
      // Compared on a forward-slash relative path so a pattern means the same thing on every
      // platform — the same reason report paths are normalised.
      const relativePath = relative(baseDir, absolutePath).split(sep).join("/");
      // Outside the ignore file's directory entirely: its patterns say nothing about it.
      if (relativePath === "" || relativePath.startsWith("../")) return false;

      let ignored = false;
      // Last match wins, so a later `!pattern` can re-include something an earlier line excluded.
      for (const rule of rules) {
        // A directory-only rule matches the directory itself, or anything strictly inside it.
        const matched = rule.insideMatcher
          ? (isDirectory && rule.matcher.test(relativePath)) ||
            rule.insideMatcher.test(relativePath)
          : rule.matcher.test(relativePath);
        if (!matched) continue;
        used.add(rule.source);
        ignored = !rule.negated;
      }
      return ignored;
    },
    unusedPatterns() {
      return rules.map((rule) => rule.source).filter((source) => !used.has(source));
    },
  };
}

/**
 * Find and load the ignore file governing a scan.
 *
 * Discovered by walking up from `baseDir`, the way the config file is, and stopping at the first
 * one. A second file further up is not merged: two files would make "why was this skipped" a
 * question with more than one answer.
 */
export function loadIgnoreFile(baseDir: string): IgnoreMatcher {
  let current = resolve(baseDir);
  while (true) {
    const candidate = resolve(current, IGNORE_FILE_NAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const contents = readFileSync(candidate, "utf8");
      return createMatcher(current, parseIgnoreFile(contents, candidate), candidate);
    }
    const parent = dirname(current);
    if (parent === current) return noIgnore(resolve(baseDir));
    current = parent;
  }
}
