import { createRuleContext } from "./context.js";
import { validateRuleFindings, validateUniqueFindingId } from "./rule-result.js";
import type {
  Confidence,
  FairUxReport,
  Finding,
  Rule,
  RuleOverride,
  Runtime,
  ScanOptions,
  Severity,
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
 * capped at "medium". Applied centrally here, not inside rules. See ADR P6-T2 §5.
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
 * A rule runs when, in priority order:
 *  - the user's override explicitly enables/disables it (object form or boolean), then
 *  - experimental rules require `includeExperimental` (an explicit `enabled: true` still bypasses), then
 *  - the rule's own `defaultEnabled` decides.
 */
function isRuleActive(
  rule: Rule,
  includeExperimental: boolean,
  override: RuleOverride | undefined,
): boolean {
  if (override?.enabled === false) return false;
  if (override?.enabled === true) return true;
  if (rule.meta.experimental) return includeExperimental;
  return rule.meta.defaultEnabled !== false;
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

  for (const rule of rules) {
    const override = resolveOverride(
      Object.hasOwn(overrides, rule.meta.id) ? overrides[rule.meta.id] : undefined,
    );
    if (!isRuleActive(rule, includeExperimental, override)) continue;
    if (!isRuleApplicable(rule, doc)) continue;
    const ctx = createRuleContext({ doc, rule, locale, dictionary, counter });
    // Post-process each finding centrally so rules stay policy-unaware:
    //  - severity override (user config) — fingerprints exclude severity, so baselines stay stable;
    //  - confidence ceiling (per-runtime) — e.g. AST findings can't read as certain.
    const overrideSeverity = override?.severity;
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

  const bySeverity = emptySeverityCounts();
  for (const finding of findings) bySeverity[finding.severity]++;

  const report: FairUxReport = {
    kind: "single",
    schemaVersion: "0.1",
    toolVersion,
    generatedAt: now().toISOString(),
    input: { file: doc.metadata?.file, runtime: doc.runtime },
    summary: { total: findings.length, bySeverity },
    findings,
  };
  if (options.rulePacks && options.rulePacks.length > 0) {
    return { ...report, rulePacks: options.rulePacks };
  }
  return report;
}
