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

const appImportViolations = [];
if (existsSync("apps")) {
  for (const file of await collect("apps")) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/\bfrom\s+["']\.\.\/\.\.\/[^"']+\/src\/[^"']+["']/.test(line)) {
        appImportViolations.push(
          `  ${file}:${i + 1}  [cross-app private source import]  ${line.trim()}`,
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

if (appImportViolations.length > 0) {
  console.error("✖ App boundary check failed. Apps must not import another app's private src:\n");
  console.error(appImportViolations.join("\n"));
  console.error(`\n${appImportViolations.length} violation(s).`);
  process.exit(1);
}

console.log("✓ Browser-safety check passed (core/rules are Node-free).");
console.log("✓ App boundary check passed (no cross-app private source imports).");
