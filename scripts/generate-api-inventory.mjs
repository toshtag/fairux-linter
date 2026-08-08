#!/usr/bin/env node
/**
 * The public SDK surface, as a checked-in inventory.
 *
 * A stable API is one where adding to it and breaking it look different in a diff. Without this
 * artifact they looked identical: the surface was whatever the entry points happened to export, and
 * nothing noticed when a name left.
 *
 * Read from the **built declarations** rather than from source. A consumer's TypeScript sees
 * `dist/*.d.ts`; an inventory generated from `src` would agree with the code and could still
 * disagree with the package, which is the one disagreement that matters.
 *
 * Two failure modes, deliberately separated:
 *
 * - A **removed or renamed** export is a break. `--check` exits non-zero and names it.
 * - An **added** export is additive. `--check` reports it and exits zero; the committed artifact
 *   then differs from a fresh run, which CI's existing worktree-cleanliness gate turns into a diff
 *   somebody reads. An addition should be visible, not fatal.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sdkEntryPoints } from "../packages/sdk/scripts/sdk-entry-points.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIST = join(ROOT, "packages/sdk/dist");
const JSON_ARTIFACT = join(ROOT, "docs/generated/sdk-api-inventory.json");
const MARKDOWN_ARTIFACT = join(ROOT, "docs/generated/sdk-api-inventory.md");

/**
 * The published entry points, from the manifest that declares them.
 *
 * This was the three specifiers with their declaration filenames, written out. The manifest is what
 * npm resolves; a subpath added there and not here would have produced an inventory that silently
 * omitted a public surface — the one failure this artifact exists to make impossible.
 */
const ENTRY_POINTS = sdkEntryPoints(
  JSON.parse(readFileSync(join(ROOT, "packages/sdk/package.json"), "utf8")),
).map((entry) => ({ specifier: entry.specifier, declaration: `${entry.base}.d.ts` }));

/**
 * Names carrying a `@deprecated` JSDoc tag, from the declarations a consumer reads.
 *
 * Recorded so "was this deprecated before it was removed?" is answerable from a committed artifact
 * rather than from memory. The tag is matched against the declaration that follows it, which is what
 * a consumer's editor shows them — a deprecation nobody sees is not one.
 */
function deprecatedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /@deprecated[\s\S]*?\*\/\s*(?:declare\s+)?(?:export\s+)?(?:type|interface|const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

/**
 * Names from a declaration file's `export { … }` statements.
 *
 * Only the re-export lists: an inventory of what a consumer can import is a list of names, and the
 * shape behind each one is the parity suite's subject rather than this file's.
 */
function exportedNames(source) {
  const names = new Map();
  for (const match of source.matchAll(/export\s*\{([^}]*)\}\s*;/g)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      const isType = trimmed.startsWith("type ");
      const withoutKind = isType ? trimmed.slice("type ".length) : trimmed;
      // `a as b` exports `b`; the local name is an implementation detail of the bundler.
      const exported = withoutKind
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (!exported || exported === "default") continue;
      names.set(exported, isType ? "type" : "value");
    }
  }
  return names;
}

/** The chunk files an entry point re-exports from, where the JSDoc actually lives. */
function sharedChunkSources(source) {
  const texts = [];
  for (const match of source.matchAll(/from\s+"\.\/([\w.-]+)"/g)) {
    const name = match[1];
    if (!name) continue;
    // A declaration file imports from `./chunk.js`; the types are in `./chunk.d.ts` beside it. The
    // first spelling tried was the one that never exists, which is why this found nothing at all.
    for (const candidate of [name.replace(/\.js$/, ".d.ts"), `${name}.d.ts`, name]) {
      try {
        texts.push(readFileSync(join(SDK_DIST, candidate), "utf8"));
        break;
      } catch {
        // Not a file next to the entry point; the next candidate spelling may be.
      }
    }
  }
  return texts;
}

function build() {
  return {
    schemaVersion: 1,
    note: "Generated from the built declarations a consumer's TypeScript reads, not from source.",
    entryPoints: ENTRY_POINTS.map((entry) => {
      const source = readFileSync(join(SDK_DIST, entry.declaration), "utf8");
      // The shared chunk too: a re-exported declaration's JSDoc lives where it was written, not
      // where it was re-exported, so reading only the entry point would find no deprecation ever.
      const shared = sharedChunkSources(source);
      const deprecated = new Set([
        ...deprecatedNames(source),
        ...shared.flatMap((text) => [...deprecatedNames(text)]),
      ]);
      const names = [...exportedNames(source)].sort(([left], [right]) => (left < right ? -1 : 1));
      return {
        specifier: entry.specifier,
        exportCount: names.length,
        exports: names.map(([name, kind]) => ({
          name,
          kind,
          ...(deprecated.has(name) ? { deprecated: true } : {}),
        })),
      };
    }),
  };
}

function renderMarkdown(inventory) {
  const lines = [
    "# SDK public API inventory",
    "",
    "<!-- Generated by scripts/generate-api-inventory.mjs. Do not edit by hand. -->",
    "",
    `> ${inventory.note}`,
    "",
    "A name leaving this file is a breaking change. A name arriving is not.",
    "",
  ];
  for (const entry of inventory.entryPoints) {
    lines.push(`## \`${entry.specifier}\``, "", `${entry.exportCount} exports.`, "");
    lines.push("| Export | Kind |", "| --- | --- |");
    for (const item of entry.exports) lines.push(`| \`${item.name}\` | ${item.kind} |`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Formatted by Biome, so a freshly generated artifact does not fail the repository's own lint. */
function formatted(contents, path) {
  const result = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", path], {
    cwd: ROOT,
    input: contents,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `Biome failed while formatting ${path}`);
  return result.stdout;
}

/**
 * Compare a fresh inventory with the committed one.
 *
 * Removals and renames are indistinguishable from here, and both are breaks: a consumer importing
 * the old name stops compiling either way.
 */
export function diffInventories(committed, current) {
  const breaking = [];
  const added = [];
  const bySpecifier = new Map(current.entryPoints.map((entry) => [entry.specifier, entry]));

  for (const before of committed.entryPoints) {
    const after = bySpecifier.get(before.specifier);
    if (!after) {
      breaking.push(`entry point ${before.specifier} is gone`);
      continue;
    }
    const afterNames = new Map(after.exports.map((item) => [item.name, item.kind]));
    const deprecationsLost = after.exports.filter(
      (item) =>
        !item.deprecated && before.exports.some((was) => was.name === item.name && was.deprecated),
    );
    for (const item of deprecationsLost) {
      // Un-deprecating is not a break, and it is a surprise. Reported so it is a decision rather
      // than a side effect of moving a comment.
      added.push(`${before.specifier}: ${item.name} is no longer deprecated`);
    }
    for (const item of before.exports) {
      const kind = afterNames.get(item.name);
      if (kind === undefined) {
        // Named with what a reader needs to judge it: a removal after a deprecation is the policy
        // working, and one without is the policy being skipped.
        breaking.push(
          `${before.specifier}: ${item.name} was removed${
            item.deprecated ? " (it was deprecated first)" : " without ever being deprecated"
          }`,
        );
      } else if (kind !== item.kind) {
        breaking.push(`${before.specifier}: ${item.name} changed from ${item.kind} to ${kind}`);
      }
    }
    const beforeNames = new Set(before.exports.map((item) => item.name));
    for (const item of after.exports) {
      if (!beforeNames.has(item.name)) added.push(`${before.specifier}: ${item.name}`);
    }
  }
  for (const after of current.entryPoints) {
    if (!committed.entryPoints.some((entry) => entry.specifier === after.specifier)) {
      added.push(`new entry point ${after.specifier}`);
    }
  }
  return { breaking, added };
}

function main() {
  const inventory = build();
  if (!process.argv.includes("--check")) {
    // Rendered and formatted only on the path that writes. `formatted()` starts `pnpm exec biome`,
    // and `--check` — the mode CI runs on every push — used to pay for that subprocess and throw
    // the result away.
    writeFileSync(
      JSON_ARTIFACT,
      formatted(`${JSON.stringify(inventory, null, 2)}\n`, JSON_ARTIFACT),
      "utf8",
    );
    writeFileSync(MARKDOWN_ARTIFACT, renderMarkdown(inventory), "utf8");
    const total = inventory.entryPoints.reduce((sum, entry) => sum + entry.exportCount, 0);
    process.stdout.write(
      `api inventory: ${total} exports across ${inventory.entryPoints.length} entry points\n`,
    );
    return;
  }

  const committed = JSON.parse(readFileSync(JSON_ARTIFACT, "utf8"));
  const { breaking, added } = diffInventories(committed, inventory);

  for (const entry of added) {
    process.stdout.write(`api inventory: added ${entry}\n`);
  }
  if (added.length > 0) {
    process.stdout.write(
      "api inventory: additions are not breaking. Run `pnpm api:inventory` so the committed diff shows them.\n",
    );
  }
  if (breaking.length > 0) {
    process.stderr.write(
      `api inventory: ${breaking.length} breaking change(s) to the published surface:\n` +
        `${breaking.map((entry) => `  - ${entry}`).join("\n")}\n` +
        "A name leaving the public surface breaks every consumer importing it. If that is intended, " +
        "it needs a deprecation and a major version, not a regenerated artifact.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("api inventory: no breaking change to the published surface\n");
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFilePath) main();

export { build };
