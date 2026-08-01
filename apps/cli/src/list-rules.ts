import type { FairuxConfig, ResolvedRuleActivation, RulePack } from "@fairux/core";
import { composeRulePacks, resolveRuleActivations } from "@fairux/core";
import { fairuxBuiltinRulePack } from "@fairux/rules";

/**
 * `fairux rules` — the rule set a scan would actually run, under the options it would run with.
 *
 * The activation itself is `@fairux/core`'s, not a second reading of it. A command whose whole
 * purpose is to say what the engine will do has to ask the engine; a copy here would drift, and the
 * drift would be invisible because both would keep passing their own tests.
 *
 * What this does *not* answer: whether a rule will report anything. A rule scoped with `appliesTo`
 * runs only where the page carries a matching context signal, which depends on the document. The
 * rendering below shows that scoping rather than hiding it, and neither format calls the enabled set
 * "coverage" — what a scan actually checked is M3's subject, and a list of enabled rules is exactly
 * the thing that gets mistaken for one.
 */

/** One row of `fairux rules`, and the documented shape of its JSON output. */
export interface RuleListEntry {
  readonly id: string;
  /** Which pack the rule came from. With one pack it is noise; with two it is the first question. */
  readonly rulePack: string;
  readonly title: string;
  readonly category: string;
  readonly enabled: boolean;
  /** Why it is or is not enabled — see `RuleActivationReason`. */
  readonly reason: string;
  /** The severity its findings will carry, after any config override. */
  readonly severity: string;
  readonly defaultSeverity: string;
  readonly experimental: boolean;
  readonly maturity: string;
  readonly version: string;
  readonly tags: readonly string[];
  /** Page contexts this rule is scoped to. Absent means it is not scoped. */
  readonly appliesTo?: readonly string[];
  /** True when the config named this rule, whether or not it changed anything. */
  readonly configured: boolean;
}

export interface RuleListing {
  /** Every composed pack, built-in first, in composition order. */
  readonly rulePacks: readonly { readonly id: string; readonly version: string }[];
  readonly includeExperimental: boolean;
  readonly rules: readonly RuleListEntry[];
}

// No "unknown configured rule id" field. A mistyped id never reaches here: both config paths — the
// auto-discovered JSON one and an explicit executable one — already refuse to load a config naming
// a rule that does not exist, listing the known ids. Reporting it again would be a field that can
// never be non-empty, which reads as a check and is not one.

function toEntry(activation: ResolvedRuleActivation, rulePack: string): RuleListEntry {
  const meta = activation.rule.meta;
  return {
    id: meta.id,
    rulePack,
    title: meta.title,
    category: meta.category,
    enabled: activation.enabled,
    reason: activation.reason,
    severity: activation.effectiveSeverity,
    defaultSeverity: meta.defaultSeverity,
    experimental: meta.experimental === true,
    maturity: meta.maturity,
    version: meta.version,
    tags: meta.tags,
    ...(meta.appliesTo && meta.appliesTo.length > 0 ? { appliesTo: meta.appliesTo } : {}),
    configured: activation.overridden,
  };
}

export function listRules(options: {
  config?: FairuxConfig;
  includeExperimental?: boolean;
  /** Composed packs, built-in first. Defaults to the built-in pack alone. */
  rulePacks?: readonly RulePack[];
}): RuleListing {
  const includeExperimental =
    options.includeExperimental ?? options.config?.includeExperimental ?? false;
  const ruleOverrides = options.config?.rules;
  const packs = options.rulePacks ?? [fairuxBuiltinRulePack];

  // Composed, not flat-mapped. `composeRulePacks` drops a pack whose own `status` is `experimental`
  // unless the flag is set — so flattening the packs would have listed a rule as enabled that a scan
  // with the same options never runs. That is the one failure this command cannot have, and it took
  // an external pack to expose it: the built-in pack is `stable`, so the two agreed by accident.
  const composed = composeRulePacks(packs, { includeExperimental });

  // Which pack a rule came from is resolved from the packs themselves, not carried on the rule:
  // `RuleMeta` has no pack field, and inventing one here would be a second source of that fact.
  const packOf = new Map<string, string>();
  for (const pack of packs) {
    for (const rule of pack.rules) {
      if (!packOf.has(rule.meta.id)) packOf.set(rule.meta.id, pack.meta.id);
    }
  }

  const activations = resolveRuleActivations(composed.rules, {
    includeExperimental,
    ruleOverrides,
  });

  return {
    rulePacks: composed.rulePacks.map((pack) => ({ id: pack.id, version: pack.version })),
    includeExperimental,
    // Sorted by id so the output is stable regardless of registry order — a list a user diffs
    // between runs must not move because a rule was added elsewhere in the registry.
    rules: activations
      .map((activation) => toEntry(activation, packOf.get(activation.rule.meta.id) ?? "unknown"))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Human-readable rendering. Machine consumers use `--format json`, whose shape is documented. */
export function renderRuleListing(listing: RuleListing): string {
  const lines: string[] = [];
  lines.push(listing.rulePacks.map((pack) => `${pack.id}@${pack.version}`).join("  +  "));

  const enabled = listing.rules.filter((rule) => rule.enabled);
  const idWidth = Math.max(...listing.rules.map((rule) => rule.id.length), 2);
  const severityWidth = Math.max(...listing.rules.map((rule) => rule.severity.length), 8);

  lines.push("");
  for (const rule of listing.rules) {
    const marker = rule.enabled ? "on " : "off";
    const notes: string[] = [];
    // Only when there is more than one pack: with a single pack every row would say the same thing.
    if (listing.rulePacks.length > 1) notes.push(rule.rulePack);
    if (rule.experimental) notes.push("experimental");
    if (rule.configured) notes.push("configured");
    // Not a footnote: a scoped rule is enabled and still silent on a page that does not match, and
    // a reader counting "on" rows without this would be counting something else.
    if (rule.appliesTo) notes.push(`only on ${rule.appliesTo.join(", ")}`);
    lines.push(
      `${marker}  ${pad(rule.id, idWidth)}  ${pad(rule.severity, severityWidth)}  ${rule.title}` +
        (notes.length > 0 ? `  (${notes.join("; ")})` : ""),
    );
  }

  lines.push("");
  lines.push(
    `${enabled.length} of ${listing.rules.length} rules enabled` +
      (listing.includeExperimental ? ", including experimental" : ""),
  );
  // Stated every time rather than only when a scoped rule is enabled: the sentence a reader needs
  // is that this list is not a statement about what was checked.
  lines.push(
    "Enabled means the rule runs, not that it reports anything: a scoped rule is silent on a page " +
      "it does not apply to, and this list is not a coverage claim.",
  );

  return lines.join("\n");
}
