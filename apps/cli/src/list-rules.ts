import type {
  CapabilityId,
  FairuxConfig,
  ResolvedRuleActivation,
  RulePack,
  Runtime,
} from "@fairux/core";
import {
  composeRulePacks,
  missingCapabilities,
  RUNTIME_CAPABILITIES,
  resolveRuleActivations,
} from "@fairux/core";
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
 * "coverage" — what a scan actually checked is a property of a scan, and a list of enabled rules is
 * exactly the thing that gets mistaken for one.
 *
 * `--runtime` narrows one of those unknowns without pretending to answer the others. What an input
 * of a given kind can supply is a property of the runtime rather than of a page, so it can be
 * answered here: with it, a rule this repository's adapter for that runtime could never satisfy is
 * marked, with what it would need. Without it, every rule's requirements are still listed, because a
 * user whose rule went silent needs to see them.
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
  /** Everything the rule needs before it can run at all. */
  readonly requiredCapabilities: readonly CapabilityId[];
  /** Capabilities that improve it where available. Absent when it declares none. */
  readonly optionalCapabilities?: readonly CapabilityId[];
  /**
   * Required capabilities the named runtime cannot supply. Present only with `--runtime`, and only
   * when non-empty: a rule that would run is not marked as anything.
   */
  readonly unsupportedOn?: readonly CapabilityId[];
  /** True when the config named this rule, whether or not it changed anything. */
  readonly configured: boolean;
}

export interface RuleListing {
  /** Every composed pack, built-in first, in composition order. */
  readonly rulePacks: readonly { readonly id: string; readonly version: string }[];
  readonly includeExperimental: boolean;
  /** The runtime the listing was resolved against, when one was named. */
  readonly runtime?: Runtime;
  /** What an input of that runtime supplies. Present only with `runtime`. */
  readonly runtimeCapabilities?: readonly CapabilityId[];
  readonly rules: readonly RuleListEntry[];
}

// No "unknown configured rule id" field. A mistyped id never reaches here: both config paths — the
// auto-discovered JSON one and an explicit executable one — already refuse to load a config naming
// a rule that does not exist, listing the known ids. Reporting it again would be a field that can
// never be non-empty, which reads as a check and is not one.

function toEntry(
  activation: ResolvedRuleActivation,
  rulePack: string,
  available: ReadonlySet<CapabilityId> | undefined,
): RuleListEntry {
  const meta = activation.rule.meta;
  const unsupportedOn = available ? missingCapabilities(meta.requiredCapabilities, available) : [];
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
    requiredCapabilities: meta.requiredCapabilities,
    ...(meta.optionalCapabilities ? { optionalCapabilities: meta.optionalCapabilities } : {}),
    ...(unsupportedOn.length > 0 ? { unsupportedOn } : {}),
    configured: activation.overridden,
  };
}

export function listRules(options: {
  config?: FairuxConfig;
  includeExperimental?: boolean;
  /** Composed packs, built-in first. Defaults to the built-in pack alone. */
  rulePacks?: readonly RulePack[];
  /** Resolve against what an input of this runtime can supply. */
  runtime?: Runtime;
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

  // The same table `scan()` resolves against, not a second reading of it. A listing that disagreed
  // with the engine about what an input supplies would be worse than one that stayed silent.
  const runtimeCapabilities = options.runtime ? RUNTIME_CAPABILITIES[options.runtime] : undefined;
  const available = runtimeCapabilities ? new Set(runtimeCapabilities) : undefined;

  return {
    rulePacks: composed.rulePacks.map((pack) => ({ id: pack.id, version: pack.version })),
    includeExperimental,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(runtimeCapabilities ? { runtimeCapabilities } : {}),
    // Sorted by id so the output is stable regardless of registry order — a list a user diffs
    // between runs must not move because a rule was added elsewhere in the registry.
    rules: activations
      .map((activation) =>
        toEntry(activation, packOf.get(activation.rule.meta.id) ?? "unknown", available),
      )
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

  if (listing.runtime) {
    lines.push(
      `against a ${listing.runtime} input, which supplies: ${(listing.runtimeCapabilities ?? []).join(", ")}`,
    );
  }

  const enabled = listing.rules.filter((rule) => rule.enabled);
  const unsupported = listing.rules.filter((rule) => rule.unsupportedOn);
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
    // A rule this input kind can never satisfy: enabled, and silent for a reason no configuration
    // change will fix. Named ahead of the softer notes because it outranks them.
    if (rule.unsupportedOn)
      notes.unshift(`cannot run here — needs ${rule.unsupportedOn.join(", ")}`);
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
  if (listing.runtime && unsupported.length > 0) {
    lines.push(
      `${unsupported.length} of them cannot run against a ${listing.runtime} input at all, whatever the configuration says.`,
    );
  }
  lines.push(
    "Enabled means the rule runs, not that it reports anything: a scoped rule is silent on a page " +
      "it does not apply to, and this list is not a coverage claim. What one scan actually checked " +
      "is in that scan's report.",
  );

  return lines.join("\n");
}
