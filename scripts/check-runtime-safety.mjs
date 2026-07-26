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

if (violations.length > 0) {
  console.error("✖ Browser-safety check failed. core/rules must not depend on Node:\n");
  console.error(violations.join("\n"));
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log("✓ Browser-safety check passed (core/rules are Node-free).");
