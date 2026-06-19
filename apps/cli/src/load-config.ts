import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
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
 *   - Auto-discovered JSON must be a regular file (no symlink — incl. dangling — no device) under a
 *     size cap. The scan target must also be reached without a project-escaping symlink: if its real
 *     path resolves outside the boundary's real path, auto-discovery fails closed (no
 *     ancestor-symlink escape, even if the link target has its own `.git`). An existing-but-unsafe
 *     nearest config is a fail-closed error, not a silent fallthrough. The vetted bytes are read
 *     in-place and returned, closing the discovery→load TOCTOU window.
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

/** Cap on an explicit `--config` JSON (more generous; the user named it, but must not OOM us). */
const MAX_EXPLICIT_CONFIG_BYTES = 16 * 1024 * 1024; // 16 MiB

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

/** Is `path` a symlink? (lstat — never follow; missing/erroring paths count as "not a symlink".) */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Does `dir` contain a regular (non-symlink) entry named `name`? */
function hasRealMarker(dir: string, name: string): boolean {
  return existsSync(resolve(dir, name)) && !isSymlink(resolve(dir, name));
}

interface BoundaryScan {
  boundary: string;
  /** A symlinked directory on the chain from the boundary down to `startDir` that escapes it. */
  symlinkOnPath?: string;
}

/**
 * Resolve the discovery boundary, then verify the scan target is reached WITHOUT a project-escaping
 * symlink. Two phases:
 *
 * 1. Boundary (lexical `lstat` walk): nearest `.git` dir reached without crossing a symlink (repo
 *    root), else nearest such `package.json` dir, else `startDir`. Stopping at the first crossed
 *    symlink keeps a symlink target's own `.git` from redefining the boundary outside the project.
 * 2. Escape check (real-path containment): if `startDir`'s real path is NOT inside the boundary's
 *    real path, a symlink on the chain relocated the scan target — fail closed. Comparing *real*
 *    paths on both sides means a benign system symlink shared by both (macOS `/var → /private/var`,
 *    a tmpdir under it) cancels out and is never flagged; only a link that actually moves the target
 *    outside the boundary is. `firstSymlinkOnChain` then names the offending link for the message.
 */
function scanBoundary(startDir: string): BoundaryScan {
  // Boundary: walk lexical parents (dirname), taking a marker only when the directory holding it is
  // itself a real (non-symlink) directory — so a symlinked dir whose TARGET has a `.git` doesn't
  // anchor the boundary there. Real ancestors above a symlink are still considered. The boundary is
  // therefore always a lexical ancestor of startDir; real-path containment below catches any escape.
  let nearestPackage: string | undefined;
  let boundary: string | undefined;
  let dir = resolve(startDir);
  while (true) {
    if (!isSymlink(dir)) {
      if (hasRealMarker(dir, ".git")) {
        boundary = dir;
        break;
      }
      if (nearestPackage === undefined && hasRealMarker(dir, "package.json")) nearestPackage = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  boundary ??= nearestPackage ?? resolve(startDir);

  // Escape check: if startDir's real path is not inside the boundary's real path, a symlink on the
  // chain relocated the target — fail closed. Real-vs-real comparison cancels benign shared system
  // links (macOS /var → /private/var), flagging only a link that actually moves the target out.
  let boundaryReal: string;
  let startReal: string;
  try {
    boundaryReal = realpathSync(boundary);
    startReal = realpathSync(resolve(startDir));
  } catch {
    return { boundary }; // can't canonicalize; the per-candidate checks still guard each JSON
  }
  const rel = relative(boundaryReal, startReal);
  const escaped = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!escaped) return { boundary };
  return { boundary, symlinkOnPath: firstSymlinkOnChain(boundary, resolve(startDir)) };
}

/**
 * Name the first symlinked directory on the lexical chain from `boundary` down to `leaf` (or `leaf`
 * itself), for the escape diagnostic. Only called once containment already proved an escape exists.
 */
function firstSymlinkOnChain(boundary: string, leaf: string): string {
  const rel = relative(resolve(boundary), leaf);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    let dir = resolve(boundary);
    for (const part of rel.split(sep)) {
      dir = resolve(dir, part);
      if (isSymlink(dir)) return dir;
    }
  }
  return isSymlink(leaf) ? leaf : resolve(boundary);
}

/**
 * Why an auto-discovered `fairux.config.json` could not be safely loaded. Each maps to a fail-closed
 * diagnostic — we surface it rather than treating the file as absent and silently falling through.
 */
type UnsafeReason = "symlink-or-irregular" | "oversized" | "read-failed";

/** A diagnostic the CLI should print to stderr before loading (or instead of loading) config. */
export interface ConfigDiagnostic {
  level: "warn" | "error";
  path: string;
  message: string;
}

/**
 * Result of auto-discovery. When a JSON config is adopted, its already-read `contents` are returned
 * too: the file is `lstat`'d and read in one go, so the bytes the CLI parses are the bytes we
 * vetted — closing the discovery→load TOCTOU window (no second `readFileSync` of a path that could
 * have been swapped for a symlink in between).
 */
export interface ConfigDiscoveryResult {
  configPath?: string;
  contents?: string;
  diagnostics: ConfigDiagnostic[];
}

/**
 * Walk from `startDir` up to the discovery boundary looking for `fairux.config.json` ONLY (data,
 * never executed), returning the first SAFE match (with its vetted contents) plus diagnostics.
 * Guarantees, all surfaced as diagnostics (never silent):
 *   - If any path component from the boundary down to the scan dir is a symlink, auto-discovery
 *     fails closed — we only trust a lexically-in-project path (no ancestor-symlink escape, even if
 *     the link target has its own `.git`).
 *   - Every `fairux.config.*` executable seen on the way is reported (`warn`) — including one that
 *     sits in the SAME directory as an adopted JSON — so a user who expected their `.ts` to apply is
 *     never left guessing.
 *   - A `fairux.config.json` that exists but is unsafe (symlink/irregular — incl. a dangling
 *     symlink, or oversized) is **fail-closed**: discovery stops with an `error` and adopts nothing,
 *     rather than falling through to a different config or to defaults.
 */
export function discoverConfig(startDir: string): ConfigDiscoveryResult {
  const { boundary, symlinkOnPath } = scanBoundary(startDir);
  const diagnostics: ConfigDiagnostic[] = [];

  // Refuse a scan target reached through a symlinked directory — fail closed, don't auto-discover.
  if (symlinkOnPath) {
    diagnostics.push({
      level: "error",
      path: symlinkOnPath,
      message:
        "is a symlink on the path to the scan target; refusing to auto-discover config across it " +
        "(pass --config explicitly, or --ignore-config).",
    });
    return { diagnostics };
  }

  let dir = resolve(startDir);
  while (true) {
    // Warn about ANY executable config in this dir, even if we adopt a JSON here or higher up.
    for (const name of EXECUTABLE_CONFIG_NAMES) {
      if (existsSync(resolve(dir, name))) {
        diagnostics.push({
          level: "warn",
          path: resolve(dir, name),
          message:
            "did not load it automatically — executable config is trusted code. Pass " +
            "--config <path> to opt in, or convert it to fairux.config.json.",
        });
        break; // one executable per directory is enough to warn
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
      diagnostics.push({ level: "error", path: json, message: unsafeMessage(inspected.reason) });
      return { diagnostics }; // fail closed — nearest config wins, even when unsafe
    }
    // kind === "absent": keep walking up.
    if (dir === boundary) break; // never search above the boundary
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
 * `lstat` a JSON candidate and, if safe, read it in the same step. `lstat` (not `existsSync`)
 * distinguishes a genuinely-absent file (ENOENT/ENOTDIR → keep walking) from a present-but-unsafe
 * one (a symlink — including dangling — or an oversized/irregular file → fail closed). Reading here
 * (rather than returning a path for the caller to re-open) means the bytes we vetted are the bytes
 * that get parsed: no discovery→load swap window.
 */
function inspectJsonCandidate(candidate: string): CandidateInspection {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unsafe", reason: "read-failed" }; // EACCES etc. — don't treat as absent
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    return { kind: "unsafe", reason: "symlink-or-irregular" };
  if (stat.size > MAX_AUTO_CONFIG_BYTES) return { kind: "unsafe", reason: "oversized" };
  try {
    return { kind: "safe", contents: readFileSync(candidate, "utf8") };
  } catch {
    return { kind: "unsafe", reason: "read-failed" };
  }
}

function unsafeMessage(reason: UnsafeReason): string {
  switch (reason) {
    case "oversized":
      return `it exceeds the ${MAX_AUTO_CONFIG_BYTES}-byte limit.`;
    case "symlink-or-irregular":
      return "it must be a regular, non-symlink file (a symlink — incl. a dangling one — is refused).";
    case "read-failed":
      return "it could not be read.";
  }
}

/** Keys that, as own properties of an untrusted JSON object, are prototype-pollution vectors. */
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

/**
 * Recursively reject `__proto__` / `constructor` / `prototype` as OWN keys anywhere in a parsed
 * config. `JSON.parse` sets these as own (not inherited) properties, so they don't pollute globals
 * — but a config object carrying them is a foot-gun for any later merge, and refusing them keeps the
 * config shape clean. Depth-bounded so a deeply-nested payload can't blow the stack.
 */
function assertNoForbiddenKeys(value: unknown, source: string, depth = 0): void {
  if (depth > 100 || value === null || typeof value !== "object") return;
  for (const key of Object.keys(value as object)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`fairux config at ${source} contains a forbidden key "${key}".`);
    }
    assertNoForbiddenKeys((value as Record<string, unknown>)[key], source, depth + 1);
  }
}

function validateConfig(value: unknown, source: string): FairuxConfig {
  if (value === null || typeof value !== "object") {
    throw new Error(`fairux config at ${source} must export an object (got ${typeof value})`);
  }
  assertNoForbiddenKeys(value, source);
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

  // Explicit JSON --config: still guard against a non-regular file (a FIFO would hang readFileSync)
  // and an oversized file (OOM). Explicit config is trusted to be *intended*, but a CI passing a
  // user-controlled --config value shouldn't be hangable/OOM-able. We DO allow a symlink here (the
  // user named this exact path), unlike auto-discovery.
  const stat = lstatSync(abs);
  const real = stat.isSymbolicLink() ? statSync(abs) : stat;
  if (!real.isFile()) {
    throw new Error(`Config file is not a regular file: ${abs}`);
  }
  if (real.size > MAX_EXPLICIT_CONFIG_BYTES) {
    throw new Error(`Config file ${abs} exceeds the ${MAX_EXPLICIT_CONFIG_BYTES}-byte limit.`);
  }
  return validateConfig(JSON.parse(readFileSync(abs, "utf8")), abs);
}

/**
 * Parse + validate an auto-discovered JSON config from the bytes `discoverConfig` already vetted and
 * read. Using the vetted contents (not re-reading the path) is what closes the discovery→load TOCTOU
 * window. `source` is only for error messages.
 */
export function parseJsonConfig(contents: string, source: string): FairuxConfig {
  return validateConfig(JSON.parse(contents), source);
}
