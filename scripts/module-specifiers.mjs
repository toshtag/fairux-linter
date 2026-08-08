/**
 * Every module a source file loads, read by esbuild's parser.
 *
 * ## Why a parser and not a scanner
 *
 * This started as four regular expressions matched line by line, then became a hand-written lexer
 * that blanked comments and string contents. Both were wrong, and wrong in ways that only showed up
 * when somebody went looking:
 *
 *     const fs = require("fs");                 // the regex matched `require` for `node:` only
 *     import /* keep *\/ "node:fs";              // a comment between the keyword and the specifier
 *     const x = `${await import("node:fs")}`;   // the lexer blanked the whole template, code and all
 *     const fs = require("\x66s");              // the lexer never decoded the escape
 *     const re = /foo import "node:fs"/;        // the lexer had no regex literals, so this was a hit
 *
 * The last three are the second round of the same failure. Each fix made the lexer a slightly larger
 * partial implementation of the JavaScript and TypeScript lexical grammar, and the remaining gaps —
 * template interpolation, regex literals, escape sequences, TSX — are not a list that gets shorter
 * by adding cases to it. Reaching a correct answer that way means writing a parser.
 *
 * So esbuild parses instead. It is already a dependency of `packages/sdk`, and it is declared at the
 * root for this. A plugin claims every specifier as it is resolved, which is the point at which
 * esbuild has finished parsing and decoding it: `"\x66s"` arrives as `fs`, an interpolated
 * `import()` arrives like any other, and a specifier that only exists inside a regex literal or a
 * comment never arrives at all.
 *
 * ## Fail-closed
 *
 * A file esbuild cannot parse yields no specifiers, which would let a syntax error turn this check
 * green. Any diagnostic that is not one of ours is re-thrown.
 *
 * ## What it cannot decide
 *
 * `import(someVariable)` and `require(base + name)`. What those load is not decidable from the
 * source, by esbuild or by anything else. Nothing in the browser-safe packages writes one, and this
 * check is not the last line of defence for a file that starts to — the bundler and each package's
 * own `tsconfig` are the others.
 */

import { build } from "esbuild";

const PLUGIN = "fairux-collect-specifiers";

/**
 * Claim every specifier as a diagnostic, so esbuild reports it with the position it was written at.
 *
 * Returning `external: true` instead would leave nothing to read the location from — esbuild gives
 * a plugin the specifier but not where it came from, and `file:line` is what makes a violation
 * actionable. Nothing is ever built here; `write` is off and every resolve fails on purpose.
 */
const collect = {
  name: PLUGIN,
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) =>
      // Entry points are the files being read, not imports found inside them.
      args.kind === "entry-point" ? null : { errors: [{ text: args.path }] },
    );
  },
};

/**
 * @param {{entryPoints: string[]} | {source: string, path: string}} input
 * @returns {Promise<{specifier: string, file: string, line: number}[]>} in the order esbuild found them
 */
export async function moduleSpecifiers(input) {
  const source = "source" in input ? input : undefined;
  if (source === undefined && input.entryPoints.length === 0) return [];

  const result = await build({
    ...(source
      ? {
          stdin: {
            contents: source.source,
            sourcefile: source.path,
            loader: loaderFor(source.path),
          },
        }
      : { entryPoints: input.entryPoints }),
    bundle: true,
    write: false,
    outdir: "/fairux-never-written", // esbuild requires one for multiple inputs; `write` is off
    logLevel: "silent",
    logLimit: 0, // every specifier is a diagnostic; the default cap would hide most of them
    platform: "neutral",
    format: "esm",
    plugins: [collect],
  }).catch((failure) => failure);

  const diagnostics = result.errors ?? [];
  const foreign = diagnostics.filter((error) => error.pluginName !== PLUGIN);
  if (foreign.length > 0) {
    throw new Error(
      `esbuild could not read a file, so its imports were not checked:\n${foreign
        .map(
          (error) => `  ${error.location?.file ?? "?"}:${error.location?.line ?? 0}  ${error.text}`,
        )
        .join("\n")}`,
    );
  }

  return diagnostics
    .filter((error) => error.pluginName === PLUGIN)
    .map((error) => ({
      specifier: error.text,
      file: error.location?.file ?? source?.path ?? "",
      line: error.location?.line ?? 0,
    }));
}

/** esbuild infers a loader from a real entry point's extension; `stdin` has to be told. */
function loaderFor(path) {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "js";
  return "ts";
}
