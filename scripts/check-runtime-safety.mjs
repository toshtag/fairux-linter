#!/usr/bin/env node
/**
 * Browser-safety guard for FairUX Core.
 *
 * `@fairux/core` and `@fairux/rules` MUST stay runtime-agnostic / browser-safe so the
 * exact same rule logic can later run inside a Chrome extension, a VS Code extension, etc.
 *
 * This script fails CI if those packages import Node built-ins or Node-only libraries.
 * It is intentionally simple and string-based — the most robust guard is the one that
 * cannot itself break. (The complementary "no /g or /y RegExp flags in dictionaries"
 * check lives as a runtime unit test inside @fairux/rules, where RegExp objects can be
 * introspected reliably rather than parsed out of source.)
 *
 * String matching is defensible *here* because the target is a bare package name in an import —
 * `node:fs`, `commander` — which cannot be spelled a hundred ways. It was not defensible for the
 * workspace boundary rule that used to live in this file: deciding whether `../../core/src` is a
 * real module load and not example text in a string, a comment, a regex, or JSX means parsing
 * JavaScript, and three review rounds of a hand-written scanner proved the point. That rule now
 * lives where it belongs — `rootDir` in each package's `tsconfig.json`, so pulling a file in from
 * another workspace is a TS6059 error from `tsc` itself during `pnpm typecheck`.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { moduleSpecifiers } from "./module-specifiers.mjs";

// Browser-safe packages: core/rules are pure; the DOM adapter may use DOM globals (not imports)
// but must stay Node-free so it can ship in a browser extension. SDK root/DOM entrypoints must
// also stay Node-free; the HTML entrypoint is Node-safe, but not a browser-safety target.
const TARGETS = [
  "packages/core/src",
  "packages/rules/src",
  "packages/dom/src",
  "packages/sdk/src/index.ts",
  "packages/sdk/src/dom.ts",
];

/**
 * What a browser-safe package may not load, by specifier.
 *
 * Matched against specifiers the parser found, not against source text: a `node:fs` inside a
 * comment or a string is not a module load, and an import split across lines or interrupted by a
 * comment still is. `module-specifiers.mjs` says why that distinction had to be made.
 */
const NODE_BUILTINS = new Set([
  "fs",
  "path",
  "os",
  "crypto",
  "process",
  "buffer",
  "util",
  "url",
  "stream",
  "child_process",
  "module",
  "http",
  "https",
  "net",
  "zlib",
]);

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

const violations = [];

for (const target of TARGETS) {
  if (!existsSync(target)) continue;
  for (const file of await collect(target)) {
    const source = await readFile(file, "utf8");
    for (const { specifier, line } of moduleSpecifiers(source, file)) {
      const reason = forbiddenReason(specifier);
      if (reason) violations.push(`  ${file}:${line}  [${reason}]  ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error("✖ Browser-safety check failed. core/rules must not depend on Node:\n");
  console.error(violations.join("\n"));
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log("✓ Browser-safety check passed (core/rules are Node-free).");
