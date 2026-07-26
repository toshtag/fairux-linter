/**
 * Workspace boundary contract — module-load detection and cross-workspace classification.
 *
 * One workspace package must not reach into another's private `src/`. Beyond layering, that import
 * is what triggered issue #57: it pulls a foreign package's sources into this package's declaration
 * program, and tsdown's tsgo generator writes out-of-root declarations next to the source.
 *
 * Getting that judgement right needs two things this file provides: knowing which strings in a file
 * are *actually* module specifiers, and knowing where a specifier resolves to.
 *
 * ## Why a tokenizer
 *
 * Two earlier attempts failed, both caught in review of PR #58:
 *
 * 1. A single regex over raw lines (`from "../../<pkg>/src/…"`) missed side-effect imports, dynamic
 *    imports, `require`, and directory imports such as `../../core/src`.
 * 2. Blanking comments and running regexes per line fixed those, but read a *string containing
 *    example code* as a real import — `const example = 'import "../../core/src/index.js"'` — and
 *    still missed anything split across lines, which is legal everywhere in JS and TS:
 *
 *      const m = import(
 *        "../../core/src/index.js"
 *      );
 *
 * Both failure directions matter. A false negative lets the issue #57 trigger back in; a false
 * positive turns an ordinary test fixture, error message, or docs example into a CI failure.
 *
 * So the source is tokenized once, tracking code, comments, strings, template literals (including
 * `${…}` expressions, which are code), and regular-expression literals. Module loads are then
 * matched against the token stream, where line breaks and interleaved comments are simply absent.
 * This also removes the previous known limitation: `/[//]/` is a regex literal, not a comment.
 *
 * Still dependency-free on purpose. This guard runs before the build, and the most reliable guard
 * is the one that cannot itself break; adopting the TypeScript compiler API — experimental at 7.0 —
 * to read six syntactic forms is not a trade worth making.
 */

const WORKSPACE_ROOT_PATTERN = /^(?:packages|apps)\/([^/]+)\//;
const WORKSPACE_SOURCE_PATTERN = /^((?:packages|apps)\/[^/]+)\/src(?:\/|$)/;

/** Normalize a path to forward slashes so Windows and POSIX behave identically. */
export function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

const isIdentifierStart = (char) => /[A-Za-z_$]/.test(char);
const isIdentifierPart = (char) => /[A-Za-z0-9_$]/.test(char);

/**
 * Keywords and punctuators after which a `/` begins a regular expression rather than a division.
 *
 * `}` is treated as regex-permitting (block end, the common case). A wrong guess is contained by
 * the same-line rule in {@link scanRegularExpression}: a regex literal cannot span a line
 * terminator, so a misread `/` falls back to punctuation instead of swallowing the rest of the file.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "typeof",
  "void",
  "yield",
]);
const REGEX_FORBIDDING_PUNCTUATORS = new Set([")", "]"]);

function regexCanFollow(previousToken) {
  if (!previousToken) return true;
  if (previousToken.type === "punct") return !REGEX_FORBIDDING_PUNCTUATORS.has(previousToken.value);
  if (previousToken.type === "word") return REGEX_PRECEDING_KEYWORDS.has(previousToken.value);
  return false;
}

/**
 * Scan a regular-expression literal starting at `/`.
 *
 * @returns {number | null} the index just past the literal, or null if it does not terminate on
 *   the same line — in which case the `/` was division, not a regex.
 */
function scanRegularExpression(source, start) {
  let index = start + 1;
  let inCharacterClass = false;

  while (index < source.length) {
    const char = source[index];
    if (char === "\n") return null;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inCharacterClass = true;
    else if (char === "]") inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1; // flags
      return index;
    }
    index += 1;
  }
  return null;
}

/**
 * Tokenize source into the pieces the module-load matcher needs.
 *
 * Comments and whitespace are dropped. Strings and expression-free template literals carry their
 * cooked value; a template literal containing `${…}` carries no value (it cannot be resolved
 * statically) while its expressions are tokenized as ordinary code.
 *
 * @returns {Array<{ type: "word" | "punct" | "string" | "template" | "regex" | "number",
 *   value: string | null, line: number }>}
 */
export function tokenize(source) {
  const tokens = [];
  /** Stack of "template" (raw text) and "template-expression" (code inside `${…}`) contexts. */
  const contexts = [];
  let index = 0;
  let line = 1;
  let mode = "code";
  let templateHasExpression = false;
  let templateValue = "";
  let templateLine = 1;

  const push = (type, value, tokenLine) => {
    tokens.push({ type, value, line: tokenLine });
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === "template") {
      if (char === "\\") {
        templateValue += next ?? "";
        if (next === "\n") line += 1;
        index += 2;
        continue;
      }
      if (char === "`") {
        push("template", templateHasExpression ? null : templateValue, templateLine);
        contexts.pop();
        mode = "code";
        index += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        templateHasExpression = true;
        contexts.push("template-expression");
        mode = "code";
        index += 2;
        continue;
      }
      if (char === "\n") line += 1;
      templateValue += char;
      index += 1;
      continue;
    }

    // --- code mode ---
    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === "/" && regexCanFollow(tokens.at(-1))) {
      const end = scanRegularExpression(source, index);
      if (end !== null) {
        push("regex", null, line);
        index = end;
        continue;
      }
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const startLine = line;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          if (source[index + 1] === "\n") line += 1;
          index += 2;
          continue;
        }
        if (source[index] === "\n") line += 1;
        value += source[index];
        index += 1;
      }
      index += 1;
      push("string", value, startLine);
      continue;
    }
    if (char === "`") {
      contexts.push("template");
      mode = "template";
      templateHasExpression = false;
      templateValue = "";
      templateLine = line;
      index += 1;
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = index;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      push("word", source.slice(start, index), line);
      continue;
    }
    if (/[0-9]/.test(char)) {
      while (index < source.length && /[0-9a-zA-Z_.]/.test(source[index])) index += 1;
      push("number", null, line);
      continue;
    }
    if (char === "}" && contexts.at(-1) === "template-expression") {
      contexts.pop();
      mode = "template";
      index += 1;
      continue;
    }
    push("punct", char, line);
    index += 1;
  }

  return tokens;
}

/** A token that can stand as a statically resolvable module specifier. */
function specifierValue(token) {
  if (!token) return null;
  if (token.type === "string") return token.value;
  // A template literal with an expression cannot be resolved statically; its value is null.
  if (token.type === "template") return token.value;
  return null;
}

const STATEMENT_SCAN_LIMIT = new Set([";", "{", "}"]);

/**
 * Find the specifier of an `import … from` / `export … from` clause starting at `startIndex`.
 *
 * Scans forward for the `from` keyword followed immediately by a specifier, stopping at a statement
 * boundary so `export const from = "…"` and `{ from: "…" }` cannot be mistaken for a clause. The
 * `{ }` of a named-import list are skipped explicitly, since they are part of the clause.
 */
function findFromSpecifier(tokens, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "punct" && token.value === "{") {
      depth += 1;
      continue;
    }
    if (token.type === "punct" && token.value === "}") {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (token.type === "punct" && STATEMENT_SCAN_LIMIT.has(token.value)) return null;
    if (token.type === "word" && (token.value === "import" || token.value === "export")) {
      if (index > startIndex) return null;
    }
    if (token.type === "word" && token.value === "from") {
      const candidate = tokens[index + 1];
      const value = specifierValue(candidate);
      return value === null ? null : { specifier: value, line: candidate.line };
    }
  }
  return null;
}

/**
 * Extract every statically resolvable module specifier from a source file.
 *
 * Recognized: `import … from`, `import "…"`, `export … from`, `import("…")`, `require("…")`, and
 * `import x = require("…")` — in any formatting, since the matcher runs on tokens.
 *
 * @returns {Array<{ specifier: string, line: number, kind: string }>}
 */
export function scanModuleSpecifiers(sourceText) {
  const tokens = tokenize(sourceText);
  const found = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "word") continue;

    if (token.value === "import") {
      const after = tokens[index + 1];

      // import "…"  /  import `…`
      const direct = specifierValue(after);
      if (direct !== null) {
        found.push({ specifier: direct, line: after.line, kind: "side-effect-import" });
        continue;
      }

      // import("…")
      if (after?.type === "punct" && after.value === "(") {
        const candidate = tokens[index + 2];
        const value = specifierValue(candidate);
        if (value !== null) {
          found.push({ specifier: value, line: candidate.line, kind: "dynamic-import" });
        }
        continue;
      }

      // import … from "…"   (import x = require("…") falls through to the `require` rule)
      const clause = findFromSpecifier(tokens, index);
      if (clause) found.push({ ...clause, kind: "static-import" });
      continue;
    }

    if (token.value === "export") {
      const clause = findFromSpecifier(tokens, index);
      if (clause) found.push({ ...clause, kind: "export-from" });
      continue;
    }

    if (token.value === "require") {
      // Skip member calls such as `assert.require(…)`; only a bare `require` loads a module.
      const before = tokens[index - 1];
      if (before?.type === "punct" && before.value === ".") continue;
      const open = tokens[index + 1];
      if (open?.type !== "punct" || open.value !== "(") continue;
      const candidate = tokens[index + 2];
      const value = specifierValue(candidate);
      if (value !== null) found.push({ specifier: value, line: candidate.line, kind: "require" });
    }
  }

  return found;
}

/**
 * Resolve a relative specifier against the importing file. Returns null for bare specifiers.
 *
 * A query or fragment suffix (`?raw`, `#frag`) is stripped before resolving — bundler runtimes
 * accept them, so leaving them attached would be an escape hatch out of this check.
 */
export function resolveRelativeSpecifier(importerPath, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;

  const withoutSuffix = specifier.replace(/[?#].*$/, "");
  const importerSegments = toPosixPath(importerPath).split("/");
  importerSegments.pop();
  for (const segment of toPosixPath(withoutSuffix).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") importerSegments.pop();
    else importerSegments.push(segment);
  }
  return importerSegments.join("/");
}

/** The `packages/<name>` or `apps/<name>` a path belongs to, or null. */
export function workspaceOf(filePath) {
  const posixPath = toPosixPath(filePath);
  const match = WORKSPACE_ROOT_PATTERN.exec(posixPath);
  return match ? posixPath.slice(0, match[0].length - 1) : null;
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
 * `line` is the line the specifier literal starts on, which for a multi-line clause is not the line
 * of the `import` keyword.
 *
 * @returns {Array<{ line: number, kind: string, specifier: string, resolved: string,
 *   importerWorkspace: string, targetWorkspace: string }>}
 */
export function auditSourceText(importerPath, sourceText) {
  const violations = [];
  for (const found of scanModuleSpecifiers(sourceText)) {
    const violation = classifyWorkspacePrivateSourceImport(importerPath, found.specifier);
    if (violation) violations.push({ line: found.line, kind: found.kind, ...violation });
  }
  return violations;
}
