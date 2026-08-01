import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RulePack } from "@fairux/core";
import { composeRulePacks } from "@fairux/core";
import { fairuxBuiltinRulePack } from "@fairux/rules";

/**
 * Loading an external RulePack from the CLI.
 *
 * **A RulePack is executable JavaScript and FairUX does not sandbox it.** It runs with the user's
 * privileges, the same as an executable `--config`. That is the repository's stated position rather
 * than a gap, and this is the point where a user meets it — so loading is explicit, per-invocation,
 * and warned about by path.
 *
 * There is deliberately no auto-discovery and no config key that loads a pack. A config file is
 * found by walking up from the working directory; a config key that loaded code would make cloning
 * a repository and running `fairux` sufficient to execute whatever that repository shipped.
 *
 * Validation is `composeRulePacks`'s, not a second copy here. It already checks pack metadata,
 * rejects duplicate pack and rule ids, and composes the taxonomy and dictionary — and a rule id
 * colliding with a built-in one has to be refused by whatever actually composes them, not by a
 * check beside it that could disagree.
 */

/** Thrown when a `--rule-pack` path cannot be loaded, with the reason a user can act on. */
export class RulePackLoadError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`cannot load rule pack "${path}": ${reason}`);
    this.name = "RulePackLoadError";
    this.path = path;
  }
}

function looksLikeRulePack(value: unknown): value is RulePack {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { meta?: unknown; rules?: unknown };
  return (
    typeof candidate.meta === "object" && candidate.meta !== null && Array.isArray(candidate.rules)
  );
}

/**
 * Find the pack a module exports, or say why it cannot.
 *
 * A default export wins outright. Otherwise every named export is considered and **exactly one**
 * must look like a pack: the authoring kit's own example exports
 * `purchaseGuardRulePack`, not `default` or `rulePack`, so a fixed list of accepted names would be a
 * rule about naming rather than about correctness. Two candidates are refused by name rather than
 * resolved by order, because picking one silently is how a user ends up running a pack they did not
 * mean to.
 */
function extractPack(module: unknown): { pack: RulePack } | { error: string } {
  if (!module || typeof module !== "object") {
    return { error: "the module exports nothing that looks like a rule pack" };
  }

  const record = module as Record<string, unknown>;
  // `default` is checked before the namespace itself, and that order is load-bearing. The loader's
  // CommonJS interop copies a default export's own properties onto the namespace *and* keeps
  // `default` on it, so a module whose default export is a pack produces a namespace that also
  // looks like one — carrying a stray `default` key that `composeRulePacks` then rejects as an
  // unknown field. Taking `default` first hands over the pack the author actually wrote.
  if (looksLikeRulePack(record.default)) return { pack: record.default };
  if (looksLikeRulePack(module)) return { pack: module };

  const named = Object.entries(record).filter(([, value]) => looksLikeRulePack(value));
  if (named.length === 1) {
    const only = named[0];
    if (only) return { pack: only[1] as RulePack };
  }
  if (named.length > 1) {
    return {
      error:
        `the module exports ${named.length} rule packs (${named.map(([name]) => name).join(", ")}) — ` +
        "export the intended one as `default` so the choice is the author's rather than the loader's",
    };
  }
  return {
    error:
      "the module exports no rule pack (expected a default export, or exactly one named export " +
      "with `meta` and `rules`)",
  };
}

/**
 * Load one external RulePack.
 *
 * @param packPath path as the user typed it
 * @param options.onBeforeExecute called after the path checks pass and immediately before the module
 *   is imported, so the warning names a path that is actually about to run
 */
export async function loadRulePack(
  packPath: string,
  options: { onBeforeExecute?: (resolvedPath: string) => void } = {},
): Promise<RulePack> {
  const abs = isAbsolute(packPath) ? packPath : resolve(packPath);
  if (!existsSync(abs)) throw new RulePackLoadError(packPath, `no such file (${abs})`);
  // A directory would be resolved as a package by the loader, which is a different and much larger
  // thing than "run this file"; refused so the warning above stays true to what happens.
  if (!statSync(abs).isFile()) throw new RulePackLoadError(packPath, `not a regular file (${abs})`);

  options.onBeforeExecute?.(abs);

  let module: unknown;
  try {
    const { createJiti } = await import("jiti");
    module = await createJiti(import.meta.url, { fsCache: false }).import(abs);
  } catch (error) {
    throw new RulePackLoadError(packPath, (error as Error).message);
  }

  const extracted = extractPack(module);
  if ("error" in extracted) throw new RulePackLoadError(packPath, extracted.error);
  return extracted.pack;
}

/**
 * Load every `--rule-pack` and compose them with the built-in pack.
 *
 * Composition happens here, once, so the failure a user sees — a malformed pack, a duplicate pack
 * id, a rule id colliding with a built-in one — happens before anything is scanned rather than
 * partway through a run.
 *
 * The built-in pack is always first. An external pack does not replace it; the composed set is the
 * built-in rules plus whatever the user brought, and `composeRulePacks` refuses a collision rather
 * than letting either win silently.
 */
export async function composeCliRulePacks(
  packPaths: readonly string[],
  options: {
    includeExperimental?: boolean;
    onBeforeExecute?: (resolvedPath: string) => void;
  } = {},
): Promise<{ packs: readonly RulePack[]; external: readonly RulePack[] }> {
  const external: RulePack[] = [];
  for (const packPath of packPaths) {
    external.push(await loadRulePack(packPath, { onBeforeExecute: options.onBeforeExecute }));
  }
  const packs = [fairuxBuiltinRulePack, ...external];

  // Compose eagerly and discard the result: this call is the validation, and running it now means a
  // bad pack is a refusal rather than a half-finished scan. `includeExperimental` is passed so a
  // pack whose rules are all experimental composes the same way it will when it runs.
  composeRulePacks(packs, { includeExperimental: options.includeExperimental ?? false });

  return { packs, external };
}
