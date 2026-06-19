import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import type { FairuxConfig } from "@fairux/core";

/**
 * Config file discovery / loading per ADR P2-T1, hardened for untrusted input (P10-T1).
 *
 * Security model: executable config (`.ts/.mjs/.js/.cjs`) is **trusted code** — loading it runs
 * arbitrary code with the caller's privileges. Scanning an untrusted repo must NEVER silently run
 * a config file it ships. So:
 *   - Auto-discovery (no `--config`) only ever picks up `fairux.config.json` — never executable.
 *     When it passes an executable `fairux.config.*` on the way, it WARNS rather than silently
 *     ignoring it, so a user who expected their `.ts` config to apply isn't left guessing.
 *   - Auto-discovered JSON must be a regular file (no symlink, no device), under a size cap, and
 *     inside the resolved discovery boundary — so it can't escape the project via a symlink.
 *   - Executable config runs ONLY when the user passes `--config <file>` explicitly, and the CLI
 *     prints a stderr warning before executing it.
 *   - Discovery is bounded: the boundary is the repo root (nearest ancestor with `.git`), else the
 *     nearest ancestor with `package.json`, else `startDir`. We search within that boundary only —
 *     so a monorepo's root config is found from a nested package, but we never reach unrelated
 *     parent directories.
 *
 * NOTE: even with `--ignore-config`, the surrounding workflow (e.g. `pnpm install && pnpm build`)
 * may still run untrusted lifecycle scripts. `--ignore-config` only isolates FairUX config.
 *
 * Loading lives here (in the CLI, a Node concern); core/rules stay browser-safe.
 */

/** The only config filename auto-discovery will pick up — JSON is data, never executed. */
const AUTO_CONFIG_NAME = "fairux.config.json";

/** Executable config filenames we recognize (for the "found but skipped" warning). */
const EXECUTABLE_CONFIG_NAMES = [
  "fairux.config.ts",
  "fairux.config.mjs",
  "fairux.config.js",
  "fairux.config.cjs",
];

/** Cap on auto-discovered JSON size — a crafted/huge file shouldn't be able to hang the scan. */
const MAX_AUTO_CONFIG_BYTES = 1024 * 1024; // 1 MiB

export type ConfigKind = "json" | "executable";

/**
 * Classify a config path by extension into the supported kinds. Throws on anything we don't
 * support, so the warning path and the load path agree on exactly the same allowlist (a `.yaml`
 * or extension-less file is rejected, not silently treated as executable). Case-insensitive.
 */
export function classifyConfigPath(filePath: string): ConfigKind {
  switch (extname(filePath).toLowerCase()) {
    case ".json":
      return "json";
    case ".ts":
    case ".mjs":
    case ".js":
    case ".cjs":
      return "executable";
    default:
      throw new Error(
        `Unsupported fairux config extension "${extname(filePath) || "(none)"}" in "${filePath}" ` +
          `(supported: .json, .ts, .mjs, .js, .cjs).`,
      );
  }
}

/** True when the path points at an executable (code) config rather than JSON data. */
export function isExecutableConfigPath(filePath: string): boolean {
  return classifyConfigPath(filePath) === "executable";
}

/**
 * Resolve the discovery boundary for `startDir`: the directory at/above `startDir` that bounds the
 * upward search. Repo root (nearest `.git`) wins; otherwise the nearest `package.json` dir;
 * otherwise `startDir` itself. This is what lets a monorepo's root config be found from a nested
 * package while never reaching unrelated parents.
 */
function discoveryBoundary(startDir: string): string {
  let nearestPackage: string | undefined;
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(resolve(dir, ".git"))) return dir; // repo root wins
    if (nearestPackage === undefined && existsSync(resolve(dir, "package.json"))) {
      nearestPackage = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return nearestPackage ?? resolve(startDir);
}

/**
 * A regular, non-symlink file within the size cap — safe to auto-load. We `lstat` (don't follow
 * links) so the config file itself can't be a symlink escaping the project. We deliberately do NOT
 * compare `realpathSync(candidate)` against `candidate`: ancestor directories are legitimately
 * symlinks on many systems (e.g. macOS `/var` → `/private/var`), which would cause false rejects.
 * The config file's own link status is what matters for escape.
 */
function isSafeAutoConfig(candidate: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(candidate); // lstat: do NOT follow symlinks
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  if (stat.size > MAX_AUTO_CONFIG_BYTES) return false;
  return true;
}

/**
 * Walk from `startDir` up to the discovery boundary looking for `fairux.config.json` ONLY (data,
 * never executed). Returns the first safe match. If an executable `fairux.config.*` is seen along
 * the way (but no JSON adopted), `onSkippedExecutable` is called with its path so the caller can
 * warn — we never silently ignore a config the user likely expected to apply.
 */
export function findConfigFile(
  startDir: string,
  onSkippedExecutable?: (path: string) => void,
): string | undefined {
  const boundary = discoveryBoundary(startDir);
  let dir = resolve(startDir);
  let skippedExecutable: string | undefined;
  while (true) {
    const json = resolve(dir, AUTO_CONFIG_NAME);
    if (existsSync(json)) {
      if (isSafeAutoConfig(json)) return json;
    } else if (skippedExecutable === undefined) {
      for (const name of EXECUTABLE_CONFIG_NAMES) {
        if (existsSync(resolve(dir, name))) {
          skippedExecutable = resolve(dir, name);
          break;
        }
      }
    }
    if (dir === boundary) break; // never search above the boundary
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (skippedExecutable && onSkippedExecutable) onSkippedExecutable(skippedExecutable);
  return undefined;
}

function validateConfig(value: unknown, source: string): FairuxConfig {
  if (value === null || typeof value !== "object") {
    throw new Error(`fairux config at ${source} must export an object (got ${typeof value})`);
  }
  const cfg = value as FairuxConfig;
  if (cfg.configVersion !== undefined && cfg.configVersion !== 1) {
    throw new Error(`Unsupported configVersion in ${source}: ${cfg.configVersion} (expected 1)`);
  }
  return cfg;
}

/** Strip C0/C1 control chars (incl. ANSI ESC) so an attacker-controlled path can't spoof output. */
export function sanitizeForTerminal(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const isControl = c <= 0x1f || (c >= 0x7f && c <= 0x9f);
    if (!isControl) out += ch;
  }
  return out;
}

export interface LoadConfigOptions {
  /**
   * Permit executing a `.ts/.mjs/.js/.cjs` config. Defaults to `false`: loading executable config
   * is opt-in (the CLI only sets this for an explicit `--config`, never for auto-discovery).
   */
  allowExecutable?: boolean;
  /**
   * Called right before an executable config is actually imported — after existence and extension
   * checks pass — so the CLI can print an accurate "executing trusted code" warning. Not called for
   * JSON or for the refusal path.
   */
  onBeforeExecute?: (resolvedPath: string) => void;
}

export async function loadConfig(
  filePath: string,
  options: LoadConfigOptions = {},
): Promise<FairuxConfig> {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }

  const kind = classifyConfigPath(abs); // allowlist; throws on unsupported extension

  if (kind === "executable") {
    if (!options.allowExecutable) {
      throw new Error(
        `Refusing to execute config "${abs}": executable config (.ts/.mjs/.js/.cjs) runs ` +
          `arbitrary code and is only loaded when passed explicitly via --config. Use a ` +
          `fairux.config.json for auto-discovery, or pass --config to opt in.`,
      );
    }
    // Accurate warning point: existence + extension already validated, import is imminent.
    options.onBeforeExecute?.(abs);
    // Dynamic import: keep jiti off the default (JSON / no-config) startup path and attack surface.
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url, { fsCache: false });
    const mod = (await jiti.import(abs)) as { default?: unknown } | unknown;
    const exported =
      mod && typeof mod === "object" && "default" in mod
        ? (mod as { default: unknown }).default
        : mod;
    return validateConfig(exported, abs);
  }

  return validateConfig(JSON.parse(readFileSync(abs, "utf8")), abs);
}
