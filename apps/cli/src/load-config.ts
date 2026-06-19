import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FairuxConfig } from "@fairux/core";

/**
 * Config file discovery / loading per ADR P2-T1, hardened for untrusted input (P10-T1).
 *
 * Security model: executable config (`.ts/.mjs/.js/.cjs`) is **trusted code** — loading it runs
 * arbitrary code with the caller's privileges. Scanning an untrusted repo must NEVER silently run
 * a config file it ships. So:
 *   - Auto-discovery (no `--config`) only ever picks up `fairux.config.json` — never executable.
 *     When it passes an executable `fairux.config.*` on the way, it WARNS (even if a JSON is later
 *     adopted), so a user who expected their `.ts` config to apply isn't left guessing.
 *   - Auto-discovered JSON must be a regular file (no symlink, no device), under a size cap, and
 *     resolve INSIDE the discovery boundary — both candidate and boundary are realpath'd, so a
 *     symlinked ancestor directory can't smuggle in an out-of-project config. An existing-but-unsafe
 *     nearest config is a fail-closed error, not a silent fallthrough to a different config.
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

/** True if `child`'s real path is the same as, or nested under, `parentReal` (already realpath'd). */
function isWithin(parentReal: string, child: string): boolean {
  let childReal: string;
  try {
    childReal = realpathSync(child);
  } catch {
    return false;
  }
  if (childReal === parentReal) return true;
  const rel = relative(parentReal, childReal);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Why an auto-discovered `fairux.config.json` could not be safely loaded. Each maps to a fail-closed
 * diagnostic — we surface it rather than treating the file as absent and silently falling through.
 */
type UnsafeReason = "symlink-or-irregular" | "oversized" | "outside-boundary" | "stat-failed";

/**
 * Check whether a discovered JSON file is safe to auto-load. Returns `undefined` when safe, or an
 * `UnsafeReason` otherwise. Both the candidate AND the boundary are canonicalized (realpath) and
 * compared, so a symlinked ANCESTOR directory can't smuggle in a config from outside the project —
 * `lstat` alone misses ancestor links. Real-path comparison also sidesteps the macOS
 * `/var → /private/var` false-reject because both sides are canonicalized.
 */
function unsafeAutoConfigReason(candidate: string, boundaryReal: string): UnsafeReason | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(candidate); // lstat: the file itself must not be a symlink
  } catch {
    return "stat-failed";
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return "symlink-or-irregular";
  if (stat.size > MAX_AUTO_CONFIG_BYTES) return "oversized";
  if (!isWithin(boundaryReal, candidate)) return "outside-boundary";
  return undefined;
}

/** A diagnostic the CLI should print to stderr before loading (or instead of loading) config. */
export interface ConfigDiagnostic {
  level: "warn" | "error";
  path: string;
  message: string;
}

/** Result of auto-discovery: the adopted config path (if any) plus diagnostics to surface. */
export interface ConfigDiscoveryResult {
  configPath?: string;
  diagnostics: ConfigDiagnostic[];
}

/**
 * Walk from `startDir` up to the discovery boundary looking for `fairux.config.json` ONLY (data,
 * never executed), returning the first SAFE match plus diagnostics. Guarantees, all surfaced as
 * diagnostics (never silent):
 *   - An executable `fairux.config.*` seen on the way is reported (`warn`), even when a JSON is
 *     ultimately adopted — so a user who expected their `.ts` to apply is never left guessing.
 *   - A `fairux.config.json` that exists but is unsafe (symlink/irregular, oversized, or escaping
 *     the boundary via an ancestor symlink) is **fail-closed**: discovery stops with an `error`
 *     diagnostic and adopts nothing, rather than falling through to a different config or to
 *     defaults. The nearest config wins; an unsafe nearest config is an error, not a fallthrough.
 */
export function discoverConfig(startDir: string): ConfigDiscoveryResult {
  const boundary = discoveryBoundary(startDir);
  let boundaryReal: string;
  try {
    boundaryReal = realpathSync(boundary);
  } catch {
    boundaryReal = resolve(boundary);
  }
  const diagnostics: ConfigDiagnostic[] = [];
  let dir = resolve(startDir);
  while (true) {
    const json = resolve(dir, AUTO_CONFIG_NAME);
    if (existsSync(json)) {
      const reason = unsafeAutoConfigReason(json, boundaryReal);
      if (reason === undefined) return { configPath: json, diagnostics };
      // Fail closed: the nearest config exists but isn't safe — don't fall through to another.
      diagnostics.push({
        level: "error",
        path: json,
        message: unsafeMessage(reason),
      });
      return { diagnostics };
    }
    for (const name of EXECUTABLE_CONFIG_NAMES) {
      const exe = resolve(dir, name);
      if (existsSync(exe)) {
        diagnostics.push({
          level: "warn",
          path: exe,
          message:
            "did not load it automatically — executable config is trusted code. Pass " +
            "--config <path> to opt in, or convert it to fairux.config.json.",
        });
        break; // one executable per directory is enough to warn
      }
    }
    if (dir === boundary) break; // never search above the boundary
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { diagnostics };
}

function unsafeMessage(reason: UnsafeReason): string {
  switch (reason) {
    case "oversized":
      return `it exceeds the ${MAX_AUTO_CONFIG_BYTES}-byte limit.`;
    case "symlink-or-irregular":
      return "it must be a regular, non-symlink file.";
    case "outside-boundary":
      return "it resolves outside the project boundary (symlink escape).";
    case "stat-failed":
      return "it could not be read.";
  }
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

/**
 * Strip characters an attacker-controlled path could use to spoof or reorder terminal/log output:
 * C0/C1 control chars (incl. ANSI ESC) and Unicode bidi/line-separator controls (U+202E etc. can
 * visually reverse a filename like "…‮gpj.exe"). Applied wherever a user-derived path reaches
 * stderr.
 */
export function sanitizeForTerminal(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const isC0C1 = c <= 0x1f || (c >= 0x7f && c <= 0x9f);
    const isBidiOrSep =
      c === 0x061c || // ARABIC LETTER MARK
      (c >= 0x200e && c <= 0x200f) || // LRM / RLM
      (c >= 0x2028 && c <= 0x2029) || // LINE / PARAGRAPH SEPARATOR
      (c >= 0x202a && c <= 0x202e) || // bidi embeddings/overrides
      (c >= 0x2066 && c <= 0x2069); // bidi isolates
    if (!isC0C1 && !isBidiOrSep) out += ch;
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
