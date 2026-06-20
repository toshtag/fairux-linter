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
 *     size cap. The scan target itself must not be a symlink, and no directory on the path to it may
 *     be a project-escaping symlink (one whose real path leaves its lexical parent's subtree) — so a
 *     symlinked ancestor (even with its own `.git`) or a symlinked scan dir fails closed, while an
 *     in-project symlink is fine. An existing-but-unsafe nearest config is a fail-closed error, not a
 *     silent fallthrough. The vetted bytes are read in-place and returned, closing the
 *     discovery→load TOCTOU window.
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
  /** A symlinked directory between the scan dir and the boundary — auto-discovery fails closed. */
  symlinkOnPath?: string;
}

/**
 * Resolve the discovery boundary using a PURELY LEXICAL, per-component symlink check — no
 * `realpath`. The rule: auto-discovery only trusts a path reached from the boundary down to the
 * scan dir WITHOUT traversing a symlinked directory. One upward pass from `startDir`:
 *
 *   - A real `.git` (repo root) / `package.json` marker fixes the boundary — but only if it is
 *     reached BEFORE crossing any symlink (markers under a symlink don't anchor a boundary, which is
 *     what would otherwise let `repo/link/sub/.git` escape). The FIRST symlink crossed going up
 *     becomes `symlinkOnPath` and ends the marker search.
 *   - If a symlink was crossed before any marker, the boundary is the real directory just BELOW that
 *     symlink, and `symlinkOnPath` is set so the caller fails closed.
 *
 * Crucially, a symlink is only flagged when it lies on the chain from the scan dir up to the
 * boundary — a symlink ABOVE the boundary (a benign system link like `/var → /private/var`, which
 * sits above any repo root) is never reached, so it's correctly ignored. No real-path comparison is
 * needed.
 */
function scanBoundary(startDir: string): BoundaryScan {
  const start = resolve(startDir);

  // First: is the scan dir reached through a RELOCATING symlink — one whose realpath leaves its
  // lexical parent's subtree (e.g. `repo/linked → ../outside`)? That's an escape (cases A and B). A
  // benign in-prefix system link (`/var → /private/var`, whose realpath stays under realpath(`/`))
  // relocates nothing observable, so it is NOT flagged. This is checked per component so a `.git`
  // sitting inside a symlinked subtree (case A) can't anchor a boundary.
  const relocating = firstRelocatingSymlink(start);
  if (relocating) return { boundary: start, symlinkOnPath: relocating };

  // No relocating symlink on the path: pick the boundary lexically — nearest real `.git`, else
  // `package.json`, else the scan dir.
  let nearestPackage: string | undefined;
  let dir = start;
  while (true) {
    if (hasRealMarker(dir, ".git")) return { boundary: dir };
    if (nearestPackage === undefined && hasRealMarker(dir, "package.json")) nearestPackage = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { boundary: nearestPackage ?? start };
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
 * Walk each directory component from the filesystem root down to `start` and return the first
 * symlink that RELOCATES the path out of its lexical parent's subtree, else `undefined`. A symlink
 * `C` relocates iff `realpath(C)` is not within `realpath(dirname(C))`. This flags
 * `repo/linked → ../outside` (its realpath escapes `repo`) but not a benign in-prefix system link
 * like `/var → /private/var` (whose realpath stays within realpath(`/`)).
 */
function firstRelocatingSymlink(start: string): string | undefined {
  const chain: string[] = [];
  let d = start;
  while (true) {
    chain.unshift(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  for (const comp of chain) {
    if (!isSymlink(comp)) continue;
    if (!realPathWithin(safeRealParent(comp), comp)) return comp;
  }
  return undefined;
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
 * SAFE match (with its vetted contents) plus diagnostics. All refusals are surfaced as diagnostics
 * (never silent):
 *   - The scan target itself must be a regular, non-symlink file in a real (non-symlink) directory;
 *     a symlinked target (or a symlink anywhere on the path up to the boundary) fails closed, so a
 *     symlink can't relocate either the config search or the scanned file out of the project.
 *   - The boundary is the nearest real `.git`/`package.json` reached without crossing a symlink.
 *   - A directory holding an executable `fairux.config.*` is reported (`warn`) — including the dir
 *     whose JSON is adopted — so a user who expected their `.ts` to apply is never left guessing.
 *   - A `fairux.config.json` that exists but is unsafe (symlink/irregular — incl. a dangling
 *     symlink, or oversized) is **fail-closed**: discovery stops with an `error` and adopts nothing,
 *     rather than falling through to a different config or to defaults.
 */
export function discoverConfig(targetPath: string): ConfigDiscoveryResult {
  const target = resolve(targetPath);
  const startDir = dirname(target);
  const diagnostics: ConfigDiagnostic[] = [];

  // The scan target file itself must not be a symlink (it could point outside the project, letting
  // a scan read out-of-project bytes). lstat it directly.
  if (isSymlink(target)) {
    diagnostics.push({
      level: "error",
      path: target,
      message:
        "the scan target is a symlink; refusing to auto-discover config for it " +
        "(pass --config explicitly, or --ignore-config).",
    });
    return { diagnostics };
  }

  const { boundary, symlinkOnPath } = scanBoundary(startDir);

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
