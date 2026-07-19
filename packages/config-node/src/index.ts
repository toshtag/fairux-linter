import { existsSync, lstatSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FairuxConfig, Severity } from "@fairux/core";
import { allRules } from "@fairux/rules";
import { ConfigFileReadError, readAutoDiscoveredJsonConfig } from "./read-config-file.js";

export { sanitizeSingleLineDisplay } from "./display.js";
export {
  type ConfigFileOps,
  ConfigFileReadError,
  type ConfigFileReadFailureReason,
  type IdentityVerification,
  nativeConfigFileOps,
  type ReadRegularFileOptions,
  type ReadRegularFileResult,
  readAutoDiscoveredJsonConfig,
  readExplicitJsonConfig,
  readRegularUtf8FileBounded,
} from "./read-config-file.js";

/**
 * JSON config discovery / validation per ADR P2-T1, hardened for untrusted input (P10-T1).
 *
 * Security model (P10-T1 SCOPE): the only goal here is to never auto-EXECUTE config a scanned,
 * possibly untrusted repo ships. This is NOT a filesystem sandbox for the user-supplied scan target
 * (see SECURITY.md for what's explicitly out of scope). So:
 *   - Auto-discovery (no `--config`) only ever picks up `fairux.config.json` — never executable.
 *     When it passes an executable `fairux.config.*` on the way, it WARNS (even if a JSON is later
 *     adopted), so a user who expected their `.ts` config to apply isn't left guessing.
 *   - Auto-discovered JSON must be a regular non-symlink file (incl. no dangling symlink) under a
 *     size cap. An existing-but-unsafe nearest config is a fail-closed error, not a silent
 *     fallthrough. The opened descriptor is `fstat`'d, the path entry is rechecked, and the bytes
 *     parsed by callers are the bounded bytes read from that descriptor. Entry swaps fail closed
 *     when the filesystem exposes stable dev/ino identity; where identity is unavailable (for
 *     example all-zero dev/ino), FairUX does not claim regular-file replacement detection.
 *   - Executable config runs ONLY when the user passes `--config <file>` explicitly, and the CLI
 *     prints a stderr warning before executing it.
 *   - Discovery is bounded by a purely LEXICAL boundary: the repo root (nearest ancestor with
 *     `.git`), else the nearest with `package.json`, else the start directory — so a monorepo's root
 *     config is found from a nested package, but the upward search never reaches unrelated parents.
 *
 * NOTE: even with `--ignore-config`, the surrounding workflow (e.g. `pnpm install && pnpm build`)
 * may still run untrusted lifecycle scripts. `--ignore-config` only isolates FairUX config.
 *
 * Executable config loading remains in the CLI; this package is JSON-only shared Node logic.
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

/** Is `path` a symlink? (lstat — never follow; missing/erroring paths count as "not a symlink".) */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Does a directory entry exist at `path`? `lstat`-based, so a dangling symlink counts as present. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Is `path` a directory? */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Does `dir` contain a regular (non-symlink) entry named `name`? */
function hasRealMarker(dir: string, name: string): boolean {
  return existsSync(resolve(dir, name)) && !isSymlink(resolve(dir, name));
}

/**
 * The config-discovery boundary for `startDir`: the nearest ancestor (incl. `startDir`) holding a
 * `.git` (repo root), else the nearest with `package.json`, else `startDir`. Purely LEXICAL — it
 * does not resolve symlinks or try to keep the scan target inside any project. Its only job is to
 * stop the upward `fairux.config.json` search from reaching unrelated parent directories.
 *
 * Scope note: FairUX does NOT sandbox the user-supplied scan target. The target is whatever path the
 * user passed; restricting which files a user may scan (symlink containment, hard links, mounts,
 * input size/depth limits) is out of scope for config safety — see SECURITY.md.
 */
function resolveBoundary(startDir: string): string {
  let nearestPackage: string | undefined;
  let dir = resolve(startDir);
  while (true) {
    if (hasRealMarker(dir, ".git")) return dir;
    if (nearestPackage === undefined && hasRealMarker(dir, "package.json")) nearestPackage = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return nearestPackage ?? resolve(startDir);
}

/**
 * Why an auto-discovered `fairux.config.json` could not be safely loaded. Each maps to a fail-closed
 * diagnostic — we surface it rather than treating the file as absent and silently falling through.
 */
type UnsafeReason = "symlink-or-irregular" | "oversized" | "changed-during-read" | "read-failed";

/** A diagnostic the CLI should print to stderr before loading (or instead of loading) config. */
export interface ConfigDiagnostic {
  level: "warn" | "error";
  path: string;
  message: string;
}

/**
 * Result of auto-discovery. When a JSON config is adopted, its already-read `contents` are returned
 * too: the file is opened, `fstat`'d, checked against the post-open path entry, and read through a
 * bounded descriptor reader. When stable dev/ino identity is available, pre-open, descriptor, and
 * post-open identities are compared. Callers parse the returned bytes and do not re-open the path.
 */
export interface ConfigDiscoveryResult {
  configPath?: string;
  contents?: string;
  diagnostics: ConfigDiagnostic[];
}

/**
 * Discover an auto-loadable `fairux.config.json` for a scan of `targetPath`, returning the first
 * SAFE match (with its vetted contents) plus diagnostics. Focuses on config only — it does NOT
 * sandbox the scan target (FairUX scans whatever path the user passed):
 *   - The boundary is the nearest `.git`/`package.json` (lexical), bounding the upward search.
 *   - A directory holding an executable `fairux.config.*` is reported (`warn`) — including the dir
 *     whose JSON is adopted — so a user who expected their `.ts` to apply is never left guessing.
 *   - A `fairux.config.json` that exists but is unsafe (symlink/irregular — incl. a dangling
 *     symlink, or oversized) is **fail-closed**: discovery stops with an `error` and adopts nothing,
 *     rather than falling through to a different config or to defaults.
 */
export function discoverConfig(targetPath: string): ConfigDiscoveryResult {
  const resolved = resolve(targetPath);
  const startDir = isDirectory(resolved) ? resolved : dirname(resolved);
  const limit = resolveBoundary(startDir);
  const diagnostics: ConfigDiagnostic[] = [];

  let dir = startDir;
  while (true) {
    // Report EVERY executable config name present in this dir (not just the first), so the warning
    // matches the "any executable config is reported" guarantee. `lstat`-based so a dangling
    // executable-config symlink is still reported (existsSync would miss it).
    for (const name of EXECUTABLE_CONFIG_NAMES) {
      const configPath = resolve(dir, name);
      const exists = entryExists(configPath);
      if (exists) {
        diagnostics.push({
          level: "warn",
          path: configPath,
          message:
            "did not load it automatically — executable config is trusted code. Pass " +
            "--config <path> to opt in, or convert it to fairux.config.json.",
        });
      }
    }

    // Inspect the JSON candidate by lstat (NOT existsSync, which is false for a dangling symlink and
    // would let us silently fall through to a config higher up).
    const json = resolve(dir, AUTO_CONFIG_NAME);
    const inspected = inspectJsonCandidate(json);
    if (inspected.kind === "safe") {
      return { configPath: json, contents: inspected.contents, diagnostics };
    }
    if (inspected.kind === "unsafe") {
      diagnostics.push({
        level: "error",
        path: json,
        message: unsafeMessage(inspected.reason),
      });
      return { diagnostics }; // fail closed — nearest config wins, even when unsafe
    }
    // kind === "absent": keep walking up.
    if (dir === limit) break; // never search above the boundary
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { diagnostics };
}

type CandidateInspection =
  | { kind: "absent" }
  | { kind: "unsafe"; reason: UnsafeReason }
  | { kind: "safe"; contents: string };

/**
 * Inspect a JSON candidate and, if safe, read it from a vetted descriptor. The reader uses `lstat`
 * (not `existsSync`) to distinguish a genuinely-absent file (ENOENT/ENOTDIR → keep walking) from a
 * present-but-unsafe one, then opens the file, `fstat`s the descriptor, re-checks the path entry,
 * compares stable entry identity when the filesystem exposes it, and reads at most
 * MAX_AUTO_CONFIG_BYTES + 1 bytes from the descriptor.
 */
function inspectJsonCandidate(candidate: string): CandidateInspection {
  try {
    const { contents } = readAutoDiscoveredJsonConfig(candidate, MAX_AUTO_CONFIG_BYTES);
    return { kind: "safe", contents };
  } catch (error) {
    if (error instanceof ConfigFileReadError) {
      if (error.reason === "absent") return { kind: "absent" };
      return { kind: "unsafe", reason: unsafeReasonFromRead(error.reason) };
    }
    return { kind: "unsafe", reason: "read-failed" };
  }
}

function unsafeReasonFromRead(reason: ConfigFileReadError["reason"]): UnsafeReason {
  switch (reason) {
    case "symlink-or-irregular":
    case "oversized":
    case "changed-during-read":
    case "read-failed":
      return reason;
    case "absent":
      return "read-failed";
  }
}

function unsafeMessage(reason: UnsafeReason): string {
  switch (reason) {
    case "oversized":
      return `it exceeds the ${MAX_AUTO_CONFIG_BYTES}-byte limit.`;
    case "symlink-or-irregular":
      return "it must be a regular, non-symlink file (a symlink — incl. a dangling one — is refused).";
    case "changed-during-read":
      return "it changed while being inspected; retry after ensuring the config is stable.";
    case "read-failed":
      return "it could not be read.";
  }
}

/** Keys that, as own properties of an untrusted JSON object, are prototype-pollution vectors. */
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

/**
 * Reject `__proto__` / `constructor` / `prototype` as own keys anywhere in a parsed config.
 * `JSON.parse` keeps them as own properties, but refusing them avoids unsafe future merges.
 * Uses an explicit stack so deeply nested payloads cannot overflow the call stack.
 */
function assertNoForbiddenKeys(value: unknown, source: string): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    for (const key of Object.keys(current as object)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new Error(`fairux config at ${source} contains a forbidden key "${key}".`);
      }
      stack.push((current as Record<string, unknown>)[key]);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeName(value: unknown): string {
  return Array.isArray(value) ? "array" : typeof value;
}

/** Known top-level config keys. Any other key is rejected. */
const KNOWN_CONFIG_KEYS = new Set(["configVersion", "includeExperimental", "rules"]);

/** Known rule IDs from the registry. */
const KNOWN_RULE_IDS = new Set(allRules.map((r) => r.meta.id));

/** Valid severity values. */
const VALID_SEVERITIES = new Set<Severity>(["high", "medium", "low", "info"]);

export function validateConfig(value: unknown, source: string): FairuxConfig {
  if (!isRecord(value)) {
    throw new Error(`fairux config at ${source} must export an object (got ${typeName(value)})`);
  }
  assertNoForbiddenKeys(value, source);
  const cfg = value;

  // Check for unknown top-level keys
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      throw new Error(
        `fairux config at ${source} has an unknown top-level key "${key}". ` +
          `Known keys: ${[...KNOWN_CONFIG_KEYS].join(", ")}.`,
      );
    }
  }

  // Validate configVersion
  if (cfg.configVersion !== undefined && cfg.configVersion !== 1) {
    throw new Error(`Unsupported configVersion in ${source}: ${cfg.configVersion} (expected 1)`);
  }

  // Validate includeExperimental
  if (cfg.includeExperimental !== undefined && typeof cfg.includeExperimental !== "boolean") {
    throw new Error(
      `fairux config at ${source}: "includeExperimental" must be a boolean (got ${typeof cfg.includeExperimental}).`,
    );
  }

  // Validate rules
  if (cfg.rules !== undefined) {
    if (cfg.rules === null || typeof cfg.rules !== "object" || Array.isArray(cfg.rules)) {
      throw new Error(
        `fairux config at ${source}: "rules" must be an object (got ${typeof cfg.rules}).`,
      );
    }
    const rules = cfg.rules as Record<string, unknown>;
    for (const [ruleId, override] of Object.entries(rules)) {
      if (!KNOWN_RULE_IDS.has(ruleId)) {
        throw new Error(
          `fairux config at ${source}: unknown rule id "${ruleId}". ` +
            `Known rule ids: ${[...KNOWN_RULE_IDS].sort().join(", ")}.`,
        );
      }
      if (typeof override === "boolean") continue;
      if (!isRecord(override)) {
        throw new Error(
          `fairux config at ${source}: rules."${ruleId}" must be a boolean or an object (got ${typeName(override)}).`,
        );
      }
      const o = override;
      if (o.enabled !== undefined && typeof o.enabled !== "boolean") {
        throw new Error(
          `fairux config at ${source}: rules."${ruleId}".enabled must be a boolean (got ${typeof o.enabled}).`,
        );
      }
      if (o.severity !== undefined) {
        const sev = o.severity as string;
        if (!VALID_SEVERITIES.has(sev as Severity)) {
          throw new Error(
            `fairux config at ${source}: rules."${ruleId}".severity must be one of ` +
              `${[...VALID_SEVERITIES].join(", ")} (got "${sev}").`,
          );
        }
      }
      for (const k of Object.keys(o)) {
        if (k !== "enabled" && k !== "severity") {
          throw new Error(
            `fairux config at ${source}: rules."${ruleId}" has an unknown key "${k}". ` +
              `Known keys: enabled, severity.`,
          );
        }
      }
    }
  }

  return cfg as unknown as FairuxConfig;
}

/**
 * Parse + validate an auto-discovered JSON config from the bytes `discoverConfig` already vetted and
 * read. Using the vetted contents (not re-reading the path) is what closes the discovery→load TOCTOU
 * window. `source` is only for error messages.
 */
export function parseJsonConfig(contents: string, source: string): FairuxConfig {
  return validateConfig(JSON.parse(contents), source);
}
