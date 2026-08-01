import type { FairuxConfig, ResolvedRuleActivation, RuleMeta, RulePack } from "@fairux/core";
import { composeRulePacks, resolveRuleActivations } from "@fairux/core";
import { DISCLAIMER } from "@fairux/report";
import { fairuxBuiltinRulePack } from "@fairux/rules";

/**
 * `fairux explain <rule-id>` — what one rule checks, under what governance, and what it does not
 * establish.
 *
 * The metadata is the generated governance record, not prose written here: maturity, jurisdictions,
 * official sources with their publisher and review date, capabilities, evidence requirements, and
 * known limitations all come from maintainer-approved review records through
 * `fairuxBuiltinRulePack`. This file decides what to show and in what order; it invents nothing.
 *
 * Two boundaries the rendering has to hold, because this is the command most likely to be read as
 * something it is not:
 *
 * - **Jurisdictions and official sources are review context, not a verdict.** They record what the
 *   maintainers read while deciding the rule was worth shipping. A page matching this rule is not
 *   thereby in breach of anything, and the disclaimer is printed rather than assumed.
 * - **Known limitations are not a footnote.** `consent/checked-checkbox` records that a `checked`
 *   attribute may not match runtime state after scripts run — that is the difference between a
 *   finding to act on and one to dismiss. A rule with none says so; an omitted section would read
 *   as "there are none", which is a stronger claim than the record supports.
 */

export interface RuleExplanation {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly rulePack: { readonly id: string; readonly version: string };
  readonly version: string;
  readonly maturity: string;
  readonly experimental: boolean;
  readonly enabled: boolean;
  readonly reason: string;
  readonly severity: string;
  readonly defaultSeverity: string;
  readonly defaultConfidence: string;
  readonly tags: readonly string[];
  readonly appliesTo?: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly optionalCapabilities?: readonly string[];
  readonly evidenceRequirements: readonly string[];
  readonly jurisdictions?: readonly string[];
  readonly officialSources?: readonly {
    readonly id: string;
    readonly title: string;
    readonly publisher: string;
    readonly url: string;
    readonly reviewedAt: string;
    readonly jurisdictions?: readonly string[];
  }[];
  /** Always present. An empty array means the record states none, not that none were recorded. */
  readonly knownLimitations: readonly string[];
  readonly references?: readonly string[];
  readonly deprecation?: {
    readonly since: string;
    readonly reason: string;
    readonly replacementRuleId?: string;
    readonly removalTarget?: string;
  };
  readonly disclaimer: string;
}

/** Thrown when no rule in the active set has the requested id. */
export class UnknownRuleError extends Error {
  readonly ruleId: string;
  readonly suggestions: readonly string[];

  constructor(ruleId: string, suggestions: readonly string[]) {
    super(
      `unknown rule id "${ruleId}"` +
        (suggestions.length > 0 ? `. Did you mean: ${suggestions.join(", ")}?` : ""),
    );
    this.name = "UnknownRuleError";
    this.ruleId = ruleId;
    this.suggestions = suggestions;
  }
}

/**
 * Rule ids worth offering for a miss.
 *
 * Substring matching in both directions rather than an edit distance: the ids are namespaced
 * (`consent/checked-checkbox`), so the common miss is remembering one half — and a category name
 * alone should offer that category's rules rather than nothing.
 */
function suggestionsFor(ruleId: string, known: readonly string[]): readonly string[] {
  const needle = ruleId.toLowerCase();
  const overlapping = known.filter(
    (id) => id.toLowerCase().includes(needle) || needle.includes(id.toLowerCase()),
  );
  if (overlapping.length > 0) return overlapping.slice(0, 5);

  // Nothing overlapped, so the whole id is wrong. The next most likely thing the user got right is
  // the namespace: `consent/typo` should offer the consent rules rather than nothing at all.
  const namespace = needle.includes("/") ? `${needle.split("/")[0]}/` : "";
  if (namespace === "") return [];
  return known.filter((id) => id.toLowerCase().startsWith(namespace)).slice(0, 5);
}

function toExplanation(
  activation: ResolvedRuleActivation,
  meta: RuleMeta,
  rulePack: { id: string; version: string },
): RuleExplanation {
  return {
    id: meta.id,
    title: meta.title,
    category: meta.category,
    rulePack,
    version: meta.version,
    maturity: meta.maturity,
    experimental: meta.experimental === true,
    enabled: activation.enabled,
    reason: activation.reason,
    severity: activation.effectiveSeverity,
    defaultSeverity: meta.defaultSeverity,
    defaultConfidence: meta.defaultConfidence,
    tags: meta.tags,
    ...(meta.appliesTo && meta.appliesTo.length > 0 ? { appliesTo: meta.appliesTo } : {}),
    requiredCapabilities: meta.requiredCapabilities,
    ...(meta.optionalCapabilities && meta.optionalCapabilities.length > 0
      ? { optionalCapabilities: meta.optionalCapabilities }
      : {}),
    evidenceRequirements: meta.evidenceRequirements,
    ...(meta.jurisdictions && meta.jurisdictions.length > 0
      ? { jurisdictions: meta.jurisdictions }
      : {}),
    ...(meta.officialSources && meta.officialSources.length > 0
      ? { officialSources: meta.officialSources.map((source) => ({ ...source })) }
      : {}),
    // Never conditional. An absent section reads as "no limitations", which the record does not say.
    knownLimitations: meta.knownLimitations ?? [],
    ...(meta.references && meta.references.length > 0 ? { references: meta.references } : {}),
    ...(meta.deprecation ? { deprecation: { ...meta.deprecation } } : {}),
    disclaimer: DISCLAIMER,
  };
}

export function explainRule(
  ruleId: string,
  options: {
    config?: FairuxConfig;
    includeExperimental?: boolean;
    /** Composed packs, built-in first. Defaults to the built-in pack alone. */
    rulePacks?: readonly RulePack[];
  } = {},
): RuleExplanation {
  const includeExperimental =
    options.includeExperimental ?? options.config?.includeExperimental ?? false;
  const packs = options.rulePacks ?? [fairuxBuiltinRulePack];
  // Composed, for the same reason `listRules` composes: a pack whose own `status` is `experimental`
  // is dropped entirely without the flag, so a rule inside it must not be explainable as enabled.
  const composed = composeRulePacks(packs, { includeExperimental });
  // The same activation the scan uses, so "enabled" here and "enabled" in `fairux rules` cannot
  // disagree — both read `@fairux/core`'s one answer.
  const activations = resolveRuleActivations(composed.rules, {
    includeExperimental,
    ruleOverrides: options.config?.rules,
  });

  const found = activations.find((activation) => activation.rule.meta.id === ruleId);
  if (!found) {
    const known = activations.map((activation) => activation.rule.meta.id);
    throw new UnknownRuleError(ruleId, suggestionsFor(ruleId, known));
  }
  const owner =
    packs.find((pack) => pack.rules.some((rule) => rule.meta.id === ruleId)) ??
    fairuxBuiltinRulePack;
  return toExplanation(found, found.rule.meta, {
    id: owner.meta.id,
    version: owner.meta.version,
  });
}

function section(title: string, body: readonly string[]): string[] {
  return body.length === 0 ? [] : ["", `${title}:`, ...body.map((line) => `  ${line}`)];
}

export function renderRuleExplanation(explanation: RuleExplanation): string {
  const lines: string[] = [
    `${explanation.id}  —  ${explanation.title}`,
    `${explanation.rulePack.id}@${explanation.rulePack.version}, rule v${explanation.version}`,
    "",
    `Category:    ${explanation.category}`,
    `Maturity:    ${explanation.maturity}` +
      (explanation.experimental && explanation.maturity !== "experimental"
        ? " (runs only with --include-experimental)"
        : ""),
    `Severity:    ${explanation.severity}` +
      (explanation.severity === explanation.defaultSeverity
        ? ""
        : ` (default ${explanation.defaultSeverity}, overridden by your config)`),
    `Confidence:  ${explanation.defaultConfidence} by default`,
    `Enabled:     ${explanation.enabled ? "yes" : "no"} (${explanation.reason})`,
  ];

  if (explanation.appliesTo) {
    // Stated as a limit on where it runs, not as a feature: a scoped rule is silent elsewhere.
    lines.push(`Runs only on: ${explanation.appliesTo.join(", ")} pages`);
  }

  lines.push(...section("Tags", [explanation.tags.join(", ")]));
  lines.push(
    ...section("Needs from the page", [
      `required: ${explanation.requiredCapabilities.join(", ")}`,
      ...(explanation.optionalCapabilities
        ? [`optional: ${explanation.optionalCapabilities.join(", ")}`]
        : []),
      `evidence: ${explanation.evidenceRequirements.join(", ")}`,
    ]),
  );

  // Known limitations come before the sources on purpose. They are what decides whether a finding
  // is worth acting on, and a reader who stops early should have read them.
  lines.push("", "Known limitations:");
  if (explanation.knownLimitations.length === 0) {
    lines.push("  The review record states none. That is not a guarantee of no false positives.");
  } else {
    for (const limitation of explanation.knownLimitations) lines.push(`  - ${limitation}`);
  }

  if (explanation.jurisdictions || explanation.officialSources) {
    lines.push("", "Review context — not a legal verdict:");
    if (explanation.jurisdictions) {
      lines.push(`  Jurisdictions considered: ${explanation.jurisdictions.join(", ")}`);
    }
    for (const source of explanation.officialSources ?? []) {
      lines.push(`  - ${source.title} — ${source.publisher} (reviewed ${source.reviewedAt})`);
      lines.push(`    ${source.url}`);
    }
  }

  lines.push(...section("References", explanation.references ?? []));

  if (explanation.deprecation) {
    lines.push("", `Deprecated since ${explanation.deprecation.since}:`);
    lines.push(`  ${explanation.deprecation.reason}`);
    if (explanation.deprecation.replacementRuleId) {
      lines.push(`  Replaced by ${explanation.deprecation.replacementRuleId}`);
    }
  }

  lines.push("", explanation.disclaimer);
  // The per-finding text is deliberately not duplicated here. A rule-level copy of "why it matters"
  // would be a second wording that drifts from the one a user actually reads in a report.
  lines.push(
    "Why a specific finding matters, and what to change, comes with the finding itself — run a scan.",
  );

  return lines.join("\n");
}
