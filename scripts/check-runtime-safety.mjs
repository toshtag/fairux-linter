#!/usr/bin/env node
/**
 * Browser-safety guard for FairUX Core.
 *
 * `@fairux/core` and `@fairux/rules` MUST stay runtime-agnostic / browser-safe so the
 * exact same rule logic can later run inside a Chrome extension, a VS Code extension, etc.
 *
 * This script fails CI if those packages import Node built-ins or Node-only libraries.
 *
 * Deciding *what* is forbidden is string matching, and that is defensible: the target is a bare
 * package name — `node:fs`, `commander` — which cannot be spelled a hundred ways. Deciding *where a
 * specifier is* is not, and two rounds of a hand-written scanner proved it; `module-specifiers.mjs`
 * hands that to a parser and says why.
 *
 * The workspace boundary rule that used to live here is gone for the same reason, to the place it
 * belongs: `rootDir` in each package's `tsconfig.json` makes pulling a file in from another
 * workspace a TS6059 error from `tsc` itself during `pnpm typecheck`.
 *
 * (The complementary "no /g or /y RegExp flags in dictionaries" check is a runtime unit test inside
 * @fairux/rules, where RegExp objects can be introspected rather than parsed out of source.)
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { moduleSpecifiers } from "./module-specifiers.mjs";

// Browser-safe packages: core/rules are pure; the DOM adapter may use DOM globals (not imports)
// but must stay Node-free so it can ship in a browser extension. SDK root/DOM entrypoints must
// also stay Node-free; the HTML entrypoint is Node-safe, but not a browser-safety target.
const DEFAULT_TARGETS = [
  "packages/core/src",
  "packages/rules/src",
  "packages/dom/src",
  "packages/sdk/src/index.ts",
  "packages/sdk/src/dom.ts",
];

/**
 * Targets may be given as arguments, which is how the fixtures exercise the exit code.
 *
 * A check whose only test is of the function underneath it has an untested half: whether a
 * violation actually reaches a non-zero exit. `pnpm check:runtime-safety` passes no arguments, so
 * what CI runs is the list above.
 */
const TARGETS = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TARGETS;

/**
 * What a browser-safe package may not load, by specifier.
 *
 * Matched against the specifiers the parser resolved, not against source text: a `node:fs` in a
 * comment, a string, or a regex literal is not a module load, and `require("\\x66s")` is.
 *
 * The builtin names come from `node:module` rather than from a list here, so a package that grows
 * a new builtin is covered without this file being edited to notice.
 */
const NODE_BUILTINS = new Set(builtinModules);

const NODE_ONLY_PACKAGES = new Set(["commander", "parse5", "node-html-parser"]);

/** core/rules must not depend on a concrete adapter — it pulls Node and parser deps in. */
const FORBIDDEN_ADAPTERS = new Set(["@fairux/html"]);

/** @returns {string | undefined} why this specifier is refused, or undefined when it is allowed */
export function forbiddenReason(specifier) {
  if (specifier.startsWith("node:")) return "node: builtin";
  if (NODE_BUILTINS.has(specifier)) return "Node builtin";
  if (NODE_ONLY_PACKAGES.has(specifier)) return "Node-only package";
  if (FORBIDDEN_ADAPTERS.has(specifier)) return "adapter dependency";
  return undefined;
}

/** Build output and installed dependencies are not sources; scanning them only invites noise. */
const SKIPPED_DIRECTORIES = ["dist", "node_modules"];

async function collect(dir) {
  if (!existsSync(dir)) return [];
  const entryStat = await stat(dir);
  if (entryStat.isFile()) return [dir];
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const entryPoints = (await Promise.all(TARGETS.filter(existsSync).map(collect))).flat();

const violations = [];
for (const { specifier, file, line } of await moduleSpecifiers({ entryPoints })) {
  const reason = forbiddenReason(specifier);
  if (reason) violations.push(`  ${file}:${line}  [${reason}]  ${specifier}`);
}

if (violations.length > 0) {
  console.error("✖ Browser-safety check failed. core/rules must not depend on Node:\n");
  console.error(violations.join("\n"));
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log("✓ Browser-safety check passed (core/rules are Node-free).");
