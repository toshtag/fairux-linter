import { existsSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import {
  parseJsonConfig,
  readExplicitJsonConfig,
  sanitizeSingleLineDisplay,
  validateConfig,
} from "@fairux/config-node";
import type { FairuxConfig } from "@fairux/core";

export { type ConfigDiagnostic, discoverConfig, parseJsonConfig } from "@fairux/config-node";

/** Cap on an explicit `--config` JSON (more generous; the user named it, but must not OOM us). */
const MAX_EXPLICIT_CONFIG_BYTES = 16 * 1024 * 1024; // 16 MiB

export type ConfigKind = "json" | "executable";

/**
 * Classify a config path by extension into the supported kinds. Throws on anything we don't
 * support, so the warning path and load path agree on the same allowlist.
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

export function sanitizeForTerminal(s: string): string {
  return sanitizeSingleLineDisplay(s);
}

export function formatTerminalError(message: unknown): string {
  return sanitizeSingleLineDisplay(message);
}

export interface LoadConfigOptions {
  /**
   * Permit executing a `.ts/.mjs/.js/.cjs` config. Defaults to `false`: loading executable config
   * is opt-in (the CLI only sets this for an explicit `--config`, never for auto-discovery).
   */
  allowExecutable?: boolean;
  /**
   * Called right before an executable config is actually imported, after existence and extension
   * checks pass, so the CLI can print an accurate trusted-code warning.
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

  const kind = classifyConfigPath(abs);
  if (kind === "executable") {
    if (!options.allowExecutable) {
      throw new Error(
        `Refusing to execute config "${abs}": executable config (.ts/.mjs/.js/.cjs) runs ` +
          `arbitrary code and is only loaded when passed explicitly via --config. Use a ` +
          `fairux.config.json for auto-discovery, or pass --config to opt in.`,
      );
    }
    options.onBeforeExecute?.(abs);
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url, { fsCache: false });
    const mod = (await jiti.import(abs)) as { default?: unknown } | unknown;
    const exported =
      mod && typeof mod === "object" && "default" in mod
        ? (mod as { default: unknown }).default
        : mod;
    return validateConfig(exported, abs);
  }

  // Explicit JSON --config: bounded descriptor read. Explicit config is trusted to be intended, so
  // unlike auto-discovery we allow a symlink to a regular file.
  const { contents } = readExplicitJsonConfig(abs, MAX_EXPLICIT_CONFIG_BYTES);
  return parseJsonConfig(contents, abs);
}
