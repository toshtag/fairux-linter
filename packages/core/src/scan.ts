import { createRuleContext } from "./context.js";
import type {
  Confidence,
  FairUxReport,
  Finding,
  Rule,
  ScanOptions,
  Severity,
  UiDocument,
} from "./types.js";

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Experimental rules run only when explicitly opted in; others run unless disabled. */
function isRuleActive(rule: Rule, includeExperimental: boolean): boolean {
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
  const toolVersion = options.toolVersion ?? "0.0.0";
  const now = options.now ?? (() => new Date());

  const findings: Finding[] = [];
  const counter = { value: 0 };

  for (const rule of rules) {
    if (!isRuleActive(rule, includeExperimental)) continue;
    if (!isRuleApplicable(rule, doc)) continue;
    const ctx = createRuleContext({ doc, rule, locale, dictionary, counter });
    for (const finding of rule.evaluate(doc, ctx)) findings.push(finding);
  }

  const bySeverity = emptySeverityCounts();
  for (const finding of findings) bySeverity[finding.severity]++;

  return {
    schemaVersion: "0.1",
    toolVersion,
    generatedAt: now().toISOString(),
    input: { file: doc.metadata?.file, runtime: doc.runtime },
    summary: { total: findings.length, bySeverity },
    findings,
  };
}
