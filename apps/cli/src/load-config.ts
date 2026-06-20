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
 *   - The scan target's safety is checked ALWAYS (see `inspectScanTarget`), before any config logic
 *     and independent of `--config` / `--ignore-config` — neither flag can bypass it. The target
 *     must be a regular, non-symlink file, and no directory on the path to it may be a
 *     project-escaping symlink (one whose real path leaves the project boundary) — so a symlinked
 *     ancestor (even with its own `.git`) or a symlinked scan dir fails closed, while an in-project
 *     symlink is fine.
 *   - Auto-discovered JSON must be a regular file (no symlink — incl. dangling — no device) under a
 *     size cap. An existing-but-unsafe nearest config is a fail-closed error, not a silent
 *     fallthrough. The vetted bytes are read in-place and returned, closing the discovery→load TOCTOU
 *     window.
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

/** True iff `child`'s real path is `parentReal` itself or nested under it. */
function realPathWithin(parentReal: string, child: string): boolean {
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
 * Resolve the discovery boundary: the nearest ancestor (incl. `startDir`) with a real `.git` (repo
 * root), else the nearest with `package.json`, else `startDir`. The walk is LEXICAL and ignores
 * symlinks entirely — it finds the OUTER real repo root even when `startDir` sits under a symlink
 * (so an ancestor-symlink escape is then judged against the real project, not a collapsed boundary).
 * Markers are taken via `lstat` (so a symlinked `.git` entry doesn't count). The escape check in
 * `inspectScanTarget` is what enforces that the path from this boundary to the target is in-project.
 */
function resolveBoundary(startDir: string): string {
  const start = resolve(startDir);
  let nearestPackage: string | undefined;
  let dir = start;
  while (true) {
    // A marker at `dir` only anchors the boundary if `dir`'s WHOLE ancestry (filesystem root → dir)
    // is free of a project-escaping symlink. Otherwise the marker lives in a symlink TARGET (e.g.
    // `repo/link/sub/.git` reached through `link`, or the link target's own `.git`) and must NOT
    // anchor the boundary; we keep walking the LEXICAL parents to find the OUTER real repo root. A
    // benign in-place system link (`/var → /private/var`) is NOT escaping (its real path stays under
    // its parent's real path), so it doesn't disturb a normal scan under a tmpdir.
    if (!pathHasEscapingSymlink(undefined, dir)) {
      if (hasRealMarker(dir, ".git")) return dir;
      if (nearestPackage === undefined && hasRealMarker(dir, "package.json")) nearestPackage = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return nearestPackage ?? start;
}

/**
 * True iff any directory on the lexical chain from `from` (a lexical ancestor of `leaf`; the
 * filesystem root when omitted) DOWN to `leaf` (inclusive) is a project-escaping symlink — one whose
 * real path is not within its own lexical parent's real path. A benign in-place link
 * (`/var → /private/var`, real path still under realpath(`/`)) is NOT escaping.
 */
function pathHasEscapingSymlink(from: string | undefined, leaf: string): boolean {
  const chain: string[] = [];
  let d = resolve(leaf);
  const top = from ? resolve(from) : undefined;
  while (true) {
    chain.unshift(d);
    if (top && d === top) break;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return chain.some((c) => isSymlink(c) && !realPathWithin(safeRealParent(c), c));
}

/** realpath of a component's lexical parent (fallback to the lexical parent if unreadable). */
function safeRealParent(comp: string): string {
  try {
    return realpathSync(dirname(comp));
  } catch {
    return dirname(comp);
  }
}

/**
 * Walk each directory component on the chain from `boundary` DOWN to `leaf` (inclusive of both) and
 * return the first symlink that ESCAPES the project — its real path is not within `boundaryReal`.
 * Only the boundary→leaf segment is checked, so a benign system link ABOVE the boundary (e.g.
 * `/var → /private/var`) is never considered, while an in-project symlink (a monorepo
 * `apps/web/src → ../../packages/shared`, whose real path stays under `boundaryReal`) is allowed and
 * an out-of-project one (`repo/linked → ../outside`) is flagged.
 */
function firstEscapingSymlink(
  boundary: string,
  leaf: string,
  boundaryReal: string,
): string | undefined {
  const chain: string[] = [];
  let d = resolve(leaf);
  const top = resolve(boundary);
  while (true) {
    chain.unshift(d);
    if (d === top) break;
    const parent = dirname(d);
    if (parent === d) break; // leaf not under boundary (shouldn't happen) — checked whole chain
    d = parent;
  }
  for (const comp of chain) {
    if (isSymlink(comp) && !realPathWithin(boundaryReal, comp)) return comp;
  }
  return undefined;
}

/** Outcome of the always-run scan-target safety check (independent of config discovery). */
export interface ScanTargetInspection {
  /** The discovery boundary for the target's directory (reused by `discoverConfig`). */
  boundary: string;
  /** Non-empty when the target is unsafe to scan — the CLI must fail closed regardless of flags. */
  diagnostics: ConfigDiagnostic[];
}

/**
 * Safety-check the SCAN TARGET itself — ALWAYS, before any config logic, so `--ignore-config` and
 * `--config` can't bypass it. The target must be a regular, non-symlink file, reached without a
 * project-escaping symlink on its path. "Project" is the repo boundary (nearest real `.git`, else
 * `package.json`, else the target's dir): a symlink whose real path stays inside the boundary is
 * allowed (a normal in-repo symlink, e.g. a monorepo `apps/web/src → ../../packages/shared`); one
 * that resolves outside it — or a symlinked target file, or a non-regular target — fails closed.
 */
export function inspectScanTarget(targetPath: string): ScanTargetInspection {
  const target = resolve(targetPath);
  const boundary = resolveBoundary(dirname(target));
  const diagnostics: ConfigDiagnostic[] = [];

  // The target's directory must be reached without a symlink that escapes the project boundary.
  let boundaryReal: string;
  try {
    boundaryReal = realpathSync(boundary);
  } catch {
    boundaryReal = boundary;
  }
  const escaping = firstEscapingSymlink(boundary, dirname(target), boundaryReal);
  if (escaping) {
    diagnostics.push({
      level: "error",
      path: escaping,
      message: "is a project-escaping symlink on the path to the scan target; refusing to scan it.",
    });
    return { boundary, diagnostics };
  }

  // The target file itself: a symlink could point out of the project; a non-regular file (FIFO,
  // socket, device, directory) could hang or misbehave. Both fail closed.
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch {
    return { boundary, diagnostics }; // missing target — let the normal read error report it
  }
  if (stat.isSymbolicLink()) {
    diagnostics.push({
      level: "error",
      path: target,
      message: "the scan target is a symlink; refusing to scan it.",
    });
  } else if (!stat.isFile()) {
    diagnostics.push({
      level: "error",
      path: target,
      message: "the scan target is not a regular file; refusing to scan it.",
    });
  }
  return { boundary, diagnostics };
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
 * Discover an auto-loadable `fairux.config.json` for a scan of `targetPath`, returning the first
 * SAFE match (with its vetted contents) plus diagnostics. The scan target's own safety (symlink /
 * irregular file / project-escaping ancestor symlink) is checked SEPARATELY and unconditionally by
 * `inspectScanTarget` — this function assumes that already passed and focuses on config:
 *   - The boundary (passed in, or recomputed) is the nearest real `.git`/`package.json`.
 *   - A directory holding an executable `fairux.config.*` is reported (`warn`) — including the dir
 *     whose JSON is adopted — so a user who expected their `.ts` to apply is never left guessing.
 *   - A `fairux.config.json` that exists but is unsafe (symlink/irregular — incl. a dangling
 *     symlink, or oversized) is **fail-closed**: discovery stops with an `error` and adopts nothing,
 *     rather than falling through to a different config or to defaults.
 */
export function discoverConfig(targetPath: string, boundary?: string): ConfigDiscoveryResult {
  const startDir = dirname(resolve(targetPath));
  const limit = boundary ?? resolveBoundary(startDir);
  const diagnostics: ConfigDiagnostic[] = [];

  let dir = startDir;
  while (true) {
    // Report EVERY executable config in this dir (not just the first), so the warning matches the
    // "any executable config is reported" guarantee exactly.
    for (const name of EXECUTABLE_CONFIG_NAMES) {
      if (existsSync(resolve(dir, name))) {
        diagnostics.push({
          level: "warn",
          path: resolve(dir, name),
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
      diagnostics.push({ level: "error", path: json, message: unsafeMessage(inspected.reason) });
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
 * Reject `__proto__` / `constructor` / `prototype` as OWN keys anywhere in a parsed config, at ANY
 * depth. `JSON.parse` sets these as own (not inherited) properties, so they don't pollute globals —
 * but a config object carrying them is a foot-gun for any later merge, and refusing them keeps the
 * config shape clean. Uses an explicit stack (not recursion) so a deeply-nested payload can't blow
 * the call stack and there's no depth cutoff that would let a deep `__proto__` slip through. The
 * total node count is already bounded by the config size cap.
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
