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
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

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

const FORBIDDEN = [
  { re: /\bfrom\s+["']node:[^"']+["']/, label: "node: builtin import" },
  { re: /\brequire\(\s*["']node:[^"']+["']\)/, label: "node: builtin require" },
  {
    re: /\bfrom\s+["'](?:fs|path|os|crypto|process|buffer|util|url|stream|child_process|module|http|https|net|zlib)["']/,
    label: "Node builtin import",
  },
  {
    re: /\bfrom\s+["'](?:commander|parse5|node-html-parser)["']/,
    label: "Node-only package import",
  },
  {
    // core/rules must not depend on a concrete adapter (it pulls Node/parser deps in).
    re: /\bfrom\s+["']@fairux\/html["']/,
    label: "adapter import (@fairux/html)",
  },
];

async function collect(dir) {
  if (!existsSync(dir)) return [];
  const entryStat = await stat(dir);
  if (entryStat.isFile()) return [dir];
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
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
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const { re, label } of FORBIDDEN) {
        if (re.test(line)) {
          violations.push(`  ${file}:${i + 1}  [${label}]  ${line.trim()}`);
        }
      }
    });
  }
}

// Cross-workspace private source imports (`../../<other>/src/...`) are not just a layering
// smell: they pull another package's `src/*.ts` into this package's declaration program, and
// tsdown's tsgo generator emits declarations for files outside the package `rootDir` next to
// the source instead of into its temp `outDir` — the build-output pollution behind issue #57.
// Guarding both `apps/` and `packages/` keeps that class of import from coming back.
const crossPackageImportViolations = [];
for (const root of ["apps", "packages"]) {
  if (!existsSync(root)) continue;
  for (const file of await collect(root)) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/\bfrom\s+["']\.\.\/\.\.\/[^"']+\/src\/[^"']+["']/.test(line)) {
        crossPackageImportViolations.push(
          `  ${file}:${i + 1}  [cross-workspace private source import]  ${line.trim()}`,
        );
      }
    });
  }
}

if (violations.length > 0) {
  console.error("✖ Browser-safety check failed. core/rules must not depend on Node:\n");
  console.error(violations.join("\n"));
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

if (crossPackageImportViolations.length > 0) {
  console.error(
    "✖ Workspace boundary check failed. Import another workspace package by its name,\n" +
      "  not through its private src (it leaks into the declaration program):\n",
  );
  console.error(crossPackageImportViolations.join("\n"));
  console.error(`\n${crossPackageImportViolations.length} violation(s).`);
  process.exit(1);
}

console.log("✓ Browser-safety check passed (core/rules are Node-free).");
console.log("✓ Workspace boundary check passed (no cross-workspace private source imports).");
