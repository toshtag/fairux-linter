import {
  BUILTIN_CAPABILITY_IDS,
  missingCapabilities,
  resolveDocumentCapabilities,
} from "./capability.js";
import { createRuleContext } from "./context.js";
import { validateRuleFindings, validateUniqueFindingId } from "./rule-result.js";
import { applySuppressionDirectives, parseSuppressionDirectives } from "./suppression-directive.js";
import type {
  AppliedSuppression,
  CapabilityId,
  Confidence,
  FairUxReport,
  Finding,
  Rule,
  RuleCoverage,
  RuleMeta,
  RuleOverride,
  RuleSkipReason,
  Runtime,
  ScanCoverage,
  ScanOptions,
  Severity,
  SuppressionDiagnostic,
  UiDocument,
} from "./types.js";

const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};
const CONFIDENCE_BY_RANK: Confidence[] = ["low", "medium", "high"];

/**
 * Per-runtime confidence ceiling. The AST runtime reads source it can only partially evaluate
 * (expression attributes/text are unknown), so a finding from it must never present as certain —
 * capped at "medium". Applied centrally here, not inside rules, so no rule can opt out of the
 * ceiling by constructing its own confidence.
 */
const RUNTIME_CONFIDENCE_CEILING: Partial<Record<Runtime, Confidence>> = {
  ast: "medium",
  figma: "low",
};

function capConfidence(value: Confidence, ceiling: Confidence | undefined): Confidence {
  if (!ceiling) return value;
  const capped = Math.min(CONFIDENCE_RANK[value], CONFIDENCE_RANK[ceiling]);
  return CONFIDENCE_BY_RANK[capped] ?? value;
}

/** Normalize the boolean/object union into a uniform object (or `undefined` for "no override"). */
function resolveOverride(raw: boolean | RuleOverride | undefined): RuleOverride | undefined {
  if (raw === undefined) return undefined;
  if (raw === false) return { enabled: false };
  if (raw === true) return { enabled: true };
  return raw;
}

/**
 * Why a rule is or is not in the active set.
 *
 * Reported rather than derived by the caller, because the priority order below is the whole subtlety
 * and a second reading of `defaultEnabled`, `experimental`, and the override union would drift from
 * this one.
 */
export type RuleActivationReason =
  /** A config override turned it on, including an experimental rule without the flag. */
  | "enabled-by-override"
  /** A config override turned it off. */
  | "disabled-by-override"
  /** Experimental, and `--include-experimental` was given. */
  | "experimental-included"
  /** Experimental, and it was not. */
  | "experimental-excluded"
  /** The rule ships off by default. */
  | "default-off"
  /** The rule ships on by default. */
  | "default-on";

/**
 * One rule's effective state under a given set of options — what a scan would actually do.
 *
 * Generic over the rule so a journey rule resolves through the same function. Enablement reads only
 * `meta`, and a second copy of the priority order for the other kind of rule would drift while both
 * kept passing their own tests. The parameter defaults to `Rule`, so every existing use is unchanged.
 */
export interface ResolvedRuleActivation<R extends { readonly meta: RuleMeta } = Rule> {
  readonly rule: R;
  readonly enabled: boolean;
  readonly reason: RuleActivationReason;
  /** The severity findings will carry, after any override. */
  readonly effectiveSeverity: Severity;
  /**
   * The override's severity, when it set one.
   *
   * Distinct from `effectiveSeverity`, which falls back to the rule's default for display. A rule
   * may emit a different severity per finding, so a scan applies this one only when it exists —
   * substituting the default would silently flatten those.
   */
  readonly severityOverride?: Severity;
  /** True when the config named this rule, whether or not it changed anything. */
  readonly overridden: boolean;
}

/**
 * A rule runs when, in priority order:
 *  - the user's override explicitly enables/disables it (object form or boolean), then
 *  - experimental rules require `includeExperimental` (an explicit `enabled: true` still bypasses), then
 *  - the rule's own `defaultEnabled` decides.
 *
 * This is the only place that order is written down. `resolveRuleActivations` turns the answer into
 * a boolean, and `scan()` reads that boolean rather than re-deriving it.
 */
function activationReason(
  rule: { readonly meta: RuleMeta },
  includeExperimental: boolean,
  override: RuleOverride | undefined,
): RuleActivationReason {
  if (override?.enabled === false) return "disabled-by-override";
  if (override?.enabled === true) return "enabled-by-override";
  if (rule.meta.experimental) {
    return includeExperimental ? "experimental-included" : "experimental-excluded";
  }
  return rule.meta.defaultEnabled !== false ? "default-on" : "default-off";
}

const ENABLED_REASONS: ReadonlySet<RuleActivationReason> = new Set([
  "enabled-by-override",
  "experimental-included",
  "default-on",
]);

/**
 * The effective state of every rule under a given set of options.
 *
 * `scan()` uses this to decide what to run, so anything else that reports the active set — the
 * CLI's `rules` command, an editor integration — describes the same decision rather than a second
 * reading of it. That is the point of exporting it: two readings of the priority order above would
 * drift, and both would keep passing their own tests while disagreeing with each other.
 *
 * It answers "is this rule enabled", not "will this rule report something". A rule with `appliesTo`
 * additionally needs a matching page-context signal, which depends on the document being scanned and
 * is deliberately not decided here.
 */
export function resolveRuleActivations<R extends { readonly meta: RuleMeta }>(
  rules: readonly R[],
  options: Pick<ScanOptions, "includeExperimental" | "ruleOverrides"> = {},
): readonly ResolvedRuleActivation<R>[] {
  const includeExperimental = options.includeExperimental ?? false;
  const overrides = options.ruleOverrides ?? {};
  return rules.map((rule) => {
    const named = Object.hasOwn(overrides, rule.meta.id);
    const override = resolveOverride(named ? overrides[rule.meta.id] : undefined);
    const reason = activationReason(rule, includeExperimental, override);
    return Object.freeze({
      rule,
      enabled: ENABLED_REASONS.has(reason),
      reason,
      effectiveSeverity: override?.severity ?? rule.meta.defaultSeverity,
      ...(override?.severity ? { severityOverride: override.severity } : {}),
      overridden: named,
    });
  });
}

/**
 * Page-context gating, applied centrally so individual rules never re-implement it.
 * A context-scoped rule fires only if the document carries a matching context signal at or
 * above the rule's minimum confidence.
 */
function isRuleApplicable(rule: Rule, doc: UiDocument): boolean {
  const applies = rule.meta.appliesTo;
  if (!applies || applies.length === 0) return true;
  const min = CONFIDENCE_RANK[rule.meta.appliesToMinConfidence ?? "low"];
  return doc.pageContexts.some(
    (signal) => applies.includes(signal.context) && CONFIDENCE_RANK[signal.confidence] >= min,
  );
}

/**
 * Capability gating, applied centrally for the same reason page-context gating is.
 *
 * A rule that names a capability the input cannot supply does not run. Running it anyway produces
 * the one outcome a report cannot distinguish from a clean result: a rule that looked with evidence
 * it does not have, found nothing, and said nothing about why.
 */
function unmetRequirements(
  rule: Rule,
  available: ReadonlySet<CapabilityId>,
): readonly CapabilityId[] {
  return missingCapabilities(rule.meta.requiredCapabilities, available);
}

function skipped(
  rule: Rule,
  skipReason: RuleSkipReason,
  extra: Pick<RuleCoverage, "missingCapabilities"> = {},
): RuleCoverage {
  return Object.freeze({ ruleId: rule.meta.id, executed: false, skipReason, ...extra });
}

/**
 * Assemble the coverage block from what the rule loop observed.
 *
 * `unavailable` is bounded by the built-in vocabulary plus what the rule set asked for. The
 * alternative — every id a rule could conceivably name — is unbounded for namespaced capabilities
 * and would describe nothing.
 */
function buildCoverage(
  availableCapabilities: readonly CapabilityId[],
  wanted: ReadonlySet<CapabilityId>,
  ruleCoverage: readonly RuleCoverage[],
): ScanCoverage {
  const available = new Set(availableCapabilities);
  const executed = ruleCoverage.filter((entry) => entry.executed).length;
  const eligible =
    executed +
    ruleCoverage.filter((entry) => entry.skipReason && entry.skipReason !== "not-enabled").length;
  return Object.freeze({
    capabilities: Object.freeze({
      available: availableCapabilities,
      unavailable: missingCapabilities([...BUILTIN_CAPABILITY_IDS, ...wanted], available),
    }),
    summary: Object.freeze({
      total: ruleCoverage.length,
      eligible,
      executed,
      skipped: eligible - executed,
    }),
    rules: Object.freeze(ruleCoverage),
  });
}

function emptySeverityCounts(): Record<Severity, number> {
  return { info: 0, low: 0, medium: 0, high: 0 };
}

export function scan(
  doc: UiDocument,
  rules: readonly Rule[],
  options: ScanOptions = {},
): FairUxReport {
  const locale = options.locale ?? "en";
  const includeExperimental = options.includeExperimental ?? false;
  const dictionary = options.dictionary ?? {};
  const overrides = options.ruleOverrides ?? {};
  const toolVersion = options.toolVersion ?? "0.0.0";
  const now = options.now ?? (() => new Date());

  const findings: Finding[] = [];
  const counter = { value: 0 };
  const seenFindingIds = new Set<string>();
  const confidenceCeiling = RUNTIME_CONFIDENCE_CEILING[doc.runtime];
  const availableCapabilities = resolveDocumentCapabilities(doc);
  const available = new Set(availableCapabilities);
  const ruleCoverage: RuleCoverage[] = [];
  const wanted = new Set<CapabilityId>();

  // One resolution, shared with whatever else reports the active set — the CLI's `rules` command
  // among them. This loop holds no second reading of the priority order.
  for (const activation of resolveRuleActivations(rules, {
    includeExperimental,
    ruleOverrides: overrides,
  })) {
    const rule = activation.rule;
    for (const capability of rule.meta.requiredCapabilities) wanted.add(capability);
    for (const capability of rule.meta.optionalCapabilities ?? []) wanted.add(capability);

    if (!activation.enabled) {
      // No capability or context detail here: neither was consulted, and reporting either would
      // describe a decision this scan never made.
      ruleCoverage.push(skipped(rule, "not-enabled"));
      continue;
    }
    // Before the page-context check: a capability the input lacks is a fact about the input, true
    // whatever context the page turns out to be.
    const unmet = unmetRequirements(rule, available);
    if (unmet.length > 0) {
      ruleCoverage.push(skipped(rule, "missing-capability", { missingCapabilities: unmet }));
      continue;
    }
    if (!isRuleApplicable(rule, doc)) {
      ruleCoverage.push(skipped(rule, "page-context-mismatch"));
      continue;
    }
    const unmetOptional = missingCapabilities(rule.meta.optionalCapabilities, available);
    ruleCoverage.push(
      Object.freeze({
        ruleId: rule.meta.id,
        executed: true,
        ...(unmetOptional.length > 0 ? { missingOptionalCapabilities: unmetOptional } : {}),
      }),
    );
    const ctx = createRuleContext({ doc, rule, locale, dictionary, counter });
    // Post-process each finding centrally so rules stay policy-unaware:
    //  - severity override (user config) — fingerprints exclude severity, so baselines stay stable;
    //  - confidence ceiling (per-runtime) — e.g. AST findings can't read as certain.
    const overrideSeverity = activation.severityOverride;
    const ruleFindings = validateRuleFindings(rule.evaluate(doc, ctx), rule);
    for (const finding of ruleFindings) {
      validateUniqueFindingId(finding, rule, seenFindingIds);
      const cappedConfidence = capConfidence(finding.confidence, confidenceCeiling);
      findings.push(
        overrideSeverity || cappedConfidence !== finding.confidence
          ? Object.freeze({
              ...finding,
              severity: overrideSeverity ?? finding.severity,
              confidence: cappedConfidence,
            })
          : finding,
      );
    }
  }

  // Applied after every rule has run, not inside the loop: a directive names a rule and a line, and
  // matching it needs the finding's evidence, which only exists once the rule produced it.
  const { directives, malformed } = parseSuppressionDirectives(doc.comments);
  const { kept, applied, unused } = applySuppressionDirectives(findings, directives);

  const diagnostics: SuppressionDiagnostic[] = [
    // A directive that named itself and could not be used is reported rather than ignored. Someone
    // who writes the keyword and gets nothing needs to be told why; silence would leave them
    // believing a finding was accepted when it was not.
    ...malformed.map((entry) => ({
      line: entry.startLine,
      kind: "malformed" as const,
      message: entry.reason,
    })),
    ...unused.map((directive) => ({
      line: directive.startLine,
      kind: "unused" as const,
      message: `no ${directive.ruleId} finding on line ${directive.startLine + 1} — remove it`,
    })),
  ];

  const bySeverity = emptySeverityCounts();
  for (const finding of kept) bySeverity[finding.severity]++;

  const report: FairUxReport = {
    kind: "single",
    schemaVersion: "0.1",
    toolVersion,
    generatedAt: now().toISOString(),
    input: { file: doc.metadata?.file, runtime: doc.runtime },
    summary: { total: kept.length, bySeverity },
    // Before the findings, because "what was checked" is the question a findings list cannot answer
    // for itself — least of all an empty one.
    coverage: buildCoverage(availableCapabilities, wanted, ruleCoverage),
    findings: kept,
    // Present only when there is something to say, so a report from a document with no directives is
    // byte-identical to what it was before this existed.
    ...(applied.length > 0 ? { suppressed: applied as readonly AppliedSuppression[] } : {}),
    ...(diagnostics.length > 0 ? { suppressionDiagnostics: diagnostics } : {}),
  };
  if (options.rulePacks && options.rulePacks.length > 0) {
    return { ...report, rulePacks: options.rulePacks };
  }
  return report;
}
