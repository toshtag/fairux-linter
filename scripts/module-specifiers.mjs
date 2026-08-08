/**
 * Every module a source file loads, found after comments and string contents are removed.
 *
 * The browser-safety check used to scan line by line with a regular expression, and each of these
 * reached `exit 0` on a real run against `packages/core/src`:
 *
 *     const fs = require("fs");         // `require` was matched for `node:` prefixes only
 *     import /* keep *\/ "node:fs";      // a comment between the keyword and the specifier
 *     const fs = await import(          // the call split across lines
 *       "node:fs"
 *     );
 *
 * Each is an ordinary thing to write, and each produced the same broken browser bundle. Adding
 * patterns is how that check got there: the round before this one added three import forms and
 * covered the one-line spelling of each, which reads like coverage and is not.
 *
 * ## Why this rather than a parser
 *
 * A parser would be better and is not available. `typescript@7` is a dependency of the CLI, and the
 * native port does not expose the compiler API — `require("typescript")` has three keys, none of
 * them `createSourceFile`. Nothing else that parses JavaScript is a declared dependency of this
 * repository, and adding one to police five directories is a worse trade than this file.
 *
 * So: one pass that knows where code *is*. Line comments, block comments, string literals and
 * template literals are blanked — keeping their line breaks, so reported line numbers stay true —
 * and the specifier forms are matched against what is left. A `node:fs` inside a comment or a
 * string is no longer a module load, and an import interrupted by a comment or a line break still
 * is.
 *
 * ## What it cannot decide
 *
 * `import(someVariable)` and `require(base + name)`. What those load is not decidable from the
 * source, by this or by a parser. Nothing in the browser-safe packages writes one, and this check
 * is not the last line of defence for a file that starts to — the bundler and each package's own
 * `tsconfig` are the others.
 */

/**
 * The source with comments and string *contents* blanked, and line breaks preserved.
 *
 * A single pass, because the states are mutually exclusive: a `//` inside a string starts no
 * comment, and a quote inside a comment starts no string. Doing it as two passes of `replace` gets
 * that wrong in both directions.
 */
export function codeOnly(source) {
  let out = "";
  let index = 0;
  const blank = (text) => text.replace(/[^\n]/g, " ");

  while (index < source.length) {
    const rest = source.slice(index);

    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }

    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      // The quotes are kept and the contents blanked, so `require("fs")` still looks like a call
      // with a string argument — the specifier is recovered from the original source by offset.
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) break;
        cursor += 1;
      }
      const stop = Math.min(cursor + 1, source.length);
      out += quote + blank(source.slice(index + 1, stop - 1)) + (source[stop - 1] ?? "");
      index = stop;
      continue;
    }

    out += source[index];
    index += 1;
  }
  return out;
}

/**
 * Where a module specifier may appear, matched against blanked code.
 *
 * `\s` rather than a literal space throughout: a comment blanked to spaces and a line break are
 * both whitespace here, which is the whole point.
 */
const FORMS = [
  // `import … from "x"`, `export … from "x"`, `export * from "x"`
  /\bfrom\s*(["'`])()/g,
  // `import "x"` — the side-effect form, with no binding
  /(?:^|[\s;{}()])import\s*(["'`])()/g,
  // `import("x")`, `require("x")`, and `import x = require("x")`
  /\b(?:import|require)\s*\(\s*(["'`])()/g,
];

/**
 * @param {string} source  file contents
 * @returns {{specifier: string, line: number}[]}  in source order, deduplicated by position
 */
export function moduleSpecifiers(source) {
  const code = codeOnly(source);
  const found = new Map();

  for (const form of FORMS) {
    form.lastIndex = 0;
    for (const match of code.matchAll(form)) {
      const quote = match[1];
      const open = match.index + match[0].length; // first character inside the quotes
      const close = source.indexOf(quote, open);
      if (close === -1) continue;
      found.set(open, {
        specifier: source.slice(open, close),
        line: source.slice(0, open).split("\n").length,
      });
    }
  }

  return [...found.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
}
