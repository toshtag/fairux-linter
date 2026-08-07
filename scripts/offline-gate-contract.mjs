/**
 * What a gate is allowed to ask a registry, resolved through the scripts it actually runs.
 *
 * `tests/unit/verify-full-contract.test.ts` claimed `pnpm verify:full` was offline by matching each
 * step's *own* command string against `registry:smoke|release:check|release:dry-run`. Every step
 * passed, and two of them ran `npm publish --dry-run` one level down: `pack:smoke` is
 * `node apps/cli/scripts/pack-smoke-test.mjs`, and the check never opened that file. A one-level
 * name match cannot see anything a script does.
 *
 * ## What it resolves
 *
 * From a set of root `package.json` script names, transitively:
 *
 * - `pnpm <name>` — another root script, followed;
 * - `pnpm --filter <pkg> <name>` and `pnpm -r <name>` — followed into each workspace manifest;
 * - `node <path>` — a file in this repository, added, and its **relative** imports followed.
 *
 * A bare binary (`vitest`, `biome`, `tsc`, `tsdown`) is a leaf: it is a dependency, not a script
 * this repository wrote, and following it would mean walking `node_modules`.
 *
 * ## What it does not resolve, said out loud
 *
 * The test suite. `test:built` is `vitest run`, and what a test file spawns is beyond this walk —
 * the reachable set stops at the runner. That is the honest limit of a static resolver, and it is
 * still strictly more than the one-level match it replaces, which is where the defect was.
 *
 * Comments are stripped before matching, so a paragraph explaining why a command was removed is not
 * mistaken for the command. The stripper is a regex, not a parser: it would also blank a `//` that
 * happened to sit inside a string literal, which costs a false negative and never a false positive.
 *
 * ## Why the subcommand and not the word "npm"
 *
 * `npm install`, `npm init`, `npm ls`, and `npm pack` are how a smoke behaves like a consumer, and
 * an install resolves dependencies from a registry. That is not the property worth defending. What
 * makes a gate unreproducible is a question whose answer *changes when this repository publishes*:
 * `npm publish --dry-run` answers `EPUBLISHCONFLICT` for a version already on npm, so a gate
 * carrying one goes red on `main` between a release and the next version bump — measured three
 * times, in PRs #299, #300, and #301. Those are the subcommands named below.
 *
 * No allowlist of scripts, no allowlist of files. The reachable set is derived, and the rule is one
 * list of npm subcommands that nobody has to keep in step with anything.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * npm subcommands whose answer depends on what this repository has published.
 *
 * `publish` is the one that has actually bitten. The rest are here because they are the same kind
 * of question — they read or write registry state, and several need credentials or ownership — and
 * a gate that grew one would have the same failure with a different message.
 */
export const REGISTRY_STATE_SUBCOMMANDS = Object.freeze([
  "publish",
  "unpublish",
  "view",
  "info",
  "dist-tag",
  "owner",
  "access",
  "whoami",
  "deprecate",
]);

const SUBCOMMAND = `(?:${REGISTRY_STATE_SUBCOMMANDS.join("|")})`;

/** `run("npm", ["publish", …])` and `execFileSync("npm", ["view", …])`. */
const ARGV_FORM = new RegExp(`["']npm["']\\s*,\\s*\\[\\s*["']${SUBCOMMAND}["']`, "g");

/** `npm publish --dry-run` written as a shell line, in a script file or a package.json command. */
const SHELL_FORM = new RegExp(`\\bnpm\\s+${SUBCOMMAND}\\b`, "g");

/** Line and block comments, blanked rather than removed so reported offsets stay meaningful. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (line, prefix) => prefix + " ".repeat(line.length - prefix.length),
    );
}

/** Every `import … from "./x.mjs"` a file resolves inside this repository. */
function relativeImports(source) {
  const found = [];
  for (const match of source.matchAll(/from\s*["'](\.[^"']+)["']/g)) found.push(match[1]);
  for (const match of source.matchAll(/import\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    found.push(match[1]);
  }
  return found;
}

/**
 * Split a package.json command into the invocations it chains.
 *
 * `&&`, `||`, and `;` only. A command substitution or a pipeline would need a shell parser, and
 * this repository's scripts do not use them — a new one that did would be visible in review.
 */
function invocations(command) {
  return command
    .split(/&&|\|\||;/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function tokens(invocation) {
  return (
    invocation.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ??
    []
  );
}

function workspaceDirs(root) {
  const found = new Map();
  for (const group of ["packages", "apps"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, "utf8"));
      if (name) found.set(name, dir);
    }
  }
  return found;
}

/**
 * Every repository file a set of root scripts reaches, and the commands they run.
 *
 * @param {string} root  the repository root
 * @param {readonly string[]} scriptNames  root `package.json` script names to start from
 * @returns {{files: string[], commands: string[]}}
 *   `files` are repository-relative; `commands` are the raw invocation strings, so a caller can
 *   check the shell form as well as the sources.
 */
export function reachableFrom(root, scriptNames) {
  const manifests = new Map();
  const manifestAt = (dir) => {
    if (!manifests.has(dir)) {
      const file = join(dir, "package.json");
      manifests.set(dir, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
    }
    return manifests.get(dir);
  };
  const workspaces = workspaceDirs(root);

  const commands = [];
  const files = new Set();
  const seen = new Set();

  const followFile = (absolute) => {
    if (files.has(absolute) || !existsSync(absolute)) return;
    files.add(absolute);
    for (const specifier of relativeImports(readFileSync(absolute, "utf8"))) {
      followFile(resolve(dirname(absolute), specifier));
    }
  };

  const followScript = (dir, name) => {
    const key = `${dir}::${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const command = manifestAt(dir).scripts?.[name];
    if (typeof command !== "string") return;

    for (const invocation of invocations(command)) {
      commands.push(invocation);
      const parts = tokens(invocation);
      if (parts[0] === "node" && parts[1] && !parts[1].startsWith("-")) {
        followFile(resolve(root, parts[1]));
        continue;
      }
      if (parts[0] !== "pnpm") continue;

      // In every form pnpm is used here, the script name is the last token.
      const target = parts[parts.length - 1];
      const filters = parts.flatMap((part, index) =>
        part === "--filter" ? [(parts[index + 1] ?? "").replace(/\.{3}$/, "")] : [],
      );
      if (filters.length > 0) {
        for (const pattern of filters) {
          for (const [name, workspace] of workspaces) {
            const matches =
              name === pattern || (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1)));
            if (matches) followScript(workspace, target);
          }
        }
        continue;
      }
      if (parts.includes("-r")) {
        for (const workspace of workspaces.values()) followScript(workspace, target);
        continue;
      }
      followScript(root, target);
    }
  };

  for (const name of scriptNames) followScript(root, name);

  return { files: [...files].map((file) => file.slice(root.length + 1)).sort(), commands };
}

/**
 * Every registry-state npm invocation reachable from a set of root scripts.
 *
 * @param {string} root
 * @param {readonly string[]} scriptNames
 * @returns {{where: string, invocation: string}[]}  empty when the gate asks the registry nothing
 */
export function registryStateCalls(root, scriptNames) {
  const { files, commands } = reachableFrom(root, scriptNames);
  const found = [];
  for (const command of commands) {
    for (const match of command.matchAll(SHELL_FORM)) {
      found.push({ where: "package.json", invocation: match[0] });
    }
  }
  for (const file of files) {
    const code = withoutComments(readFileSync(join(root, file), "utf8"));
    for (const match of code.matchAll(ARGV_FORM)) {
      found.push({ where: file, invocation: match[0] });
    }
    for (const match of code.matchAll(SHELL_FORM)) {
      found.push({ where: file, invocation: match[0] });
    }
  }
  return found;
}
