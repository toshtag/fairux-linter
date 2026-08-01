import { createRuleContext } from "./context.js";
import { validateRuleFindings, validateUniqueFindingId } from "./rule-result.js";
import { applySuppressionDirectives, parseSuppressionDirectives } from "./suppression-directive.js";
import type {
  AppliedSuppression,
  Confidence,
  FairUxReport,
  Finding,
  Rule,
  RuleOverride,
  Runtime,
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

/** One rule's effective state under a given set of options — what a scan would actually do. */
export interface ResolvedRuleActivation {
  readonly rule: Rule;
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
  rule: Rule,
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
export function resolveRuleActivations(
  rules: readonly Rule[],
  options: Pick<ScanOptions, "includeExperimental" | "ruleOverrides"> = {},
): readonly ResolvedRuleActivation[] {
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

  // One resolution, shared with whatever else reports the active set — the CLI's `rules` command
  // among them. This loop holds no second reading of the priority order.
  for (const activation of resolveRuleActivations(rules, {
    includeExperimental,
    ruleOverrides: overrides,
  })) {
    const rule = activation.rule;
    if (!activation.enabled) continue;
    if (!isRuleApplicable(rule, doc)) continue;
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
