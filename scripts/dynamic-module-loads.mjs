/**
 * Find dynamic `import(...)` and bare `require(...)` in a module, without executing it.
 *
 * The SDK's browser entry is audited for Node builtins. Static imports moved to Node's own parser,
 * but the dynamic half stayed a regex — and a comment between the keyword and its argument defeats
 * it. Reproduced against the real SDK tarball:
 *
 *     export const x = import(/* webpackIgnore: true *\/ "node:fs");   // audited clean
 *
 * Widening the regex is the wrong response. `import("node:" + "fs")` and `import(`node:fs`)` are
 * next, and each fix is another guess about a grammar. The browser entry has no reason to load a
 * module at runtime at all, so the rule is that it must not: the specifier never has to be
 * extracted, let alone evaluated.
 *
 * A minimal lexical scan is enough for that question — it must only distinguish real code from
 * comments and string literals, which is exactly what a regex cannot do.
 */

const IDENTIFIER_PART = /[\w$]/;

/**
 * @param {string} source
 * @returns {{ kind: "import" | "require", index: number }[]} every dynamic load site
 */
export function findDynamicModuleLoads(source) {
  const found = [];
  let index = 0;

  /** Skip whitespace and comments; returns the next code position. */
  const skipTrivia = (from) => {
    let at = from;
    for (;;) {
      while (at < source.length && /\s/.test(source[at])) at += 1;
      if (source.startsWith("//", at)) {
        const end = source.indexOf("\n", at);
        at = end === -1 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("/*", at)) {
        const end = source.indexOf("*/", at + 2);
        at = end === -1 ? source.length : end + 2;
        continue;
      }
      return at;
    }
  };

  while (index < source.length) {
    const char = source[index];

    // --- Skip over anything that is not code ---------------------------------------------------
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipTrivia(index);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        // A template literal's `${}` holds code, but anything inside it is still found by the
        // outer scan once this literal ends — and a load site there would be a load site anyway.
        index += 1;
      }
      continue;
    }

    // --- Keywords, at an identifier boundary ---------------------------------------------------
    if (IDENTIFIER_PART.test(char)) {
      let end = index;
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1;
      const word = source.slice(index, end);
      const before = index === 0 ? "" : source[index - 1];

      if (word === "import" || word === "require") {
        const after = skipTrivia(end);
        // `import.meta` is a property access, not a load. A `require` reached through a member
        // expression (`obj.require(...)`) is somebody else's function, not Node's.
        const isMember = before === ".";
        if (!isMember && source[after] === "(") {
          found.push({ kind: word === "import" ? "import" : "require", index });
        }
      }
      index = end;
      continue;
    }

    index += 1;
  }

  return found;
}
