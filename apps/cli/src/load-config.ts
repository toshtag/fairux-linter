import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FairuxConfig } from "@fairux/core";
import { createJiti } from "jiti";

/**
 * Config file discovery / loading per ADR P2-T1.
 * - `.json` is parsed natively (no transpile dep).
 * - `.ts/.mjs/.js/.cjs` are imported via jiti — it transpiles `.ts` on the fly so users get
 *   a typed config without forcing a build step.
 * - Loading lives here (in the CLI, a Node concern); core/rules stay browser-safe.
 */

const CONFIG_NAMES = [
  "fairux.config.ts",
  "fairux.config.mjs",
  "fairux.config.js",
  "fairux.config.cjs",
  "fairux.config.json",
];

/** Walk upward from `startDir` to the filesystem root, returning the first config file found. */
export function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
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

export async function loadConfig(filePath: string): Promise<FairuxConfig> {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }

  if (abs.endsWith(".json")) {
    return validateConfig(JSON.parse(readFileSync(abs, "utf8")), abs);
  }

  // jiti handles .ts/.mjs/.js/.cjs transparently. fsCache speeds up repeated loads in tests.
  const jiti = createJiti(import.meta.url, { fsCache: false });
  const mod = (await jiti.import(abs)) as { default?: unknown } | unknown;
  const exported =
    mod && typeof mod === "object" && "default" in mod
      ? (mod as { default: unknown }).default
      : mod;
  return validateConfig(exported, abs);
}
