/**
 * The FairUX Risk Index contract — deliberately without a formula.
 *
 * A number is the most quotable thing this project will ever emit. It travels without its coverage,
 * without its denominator, and without the sentence saying what it does not mean, so the shape it
 * travels in is settled before any weight exists.
 *
 * Nothing here scores anything. No model ships in this build: `computeRiskIndex` without one returns
 * `unsupported` with a reason, which is the accurate answer and not a degenerate score. Weights, the
 * severity-to-score conversion, confidence computation, thresholds, and calibration belong to a
 * model, and a model belongs to its own change with its own evidence.
 */

import { missingCapabilities, sortCapabilityIds } from "./capability.js";
import type {
  CapabilityId,
  Confidence,
  FairUxBatchReport,
  FairUxReport,
  Finding,
  JourneyReport,
  RulePackReference,
} from "./types.js";

/** A Risk Index request that cannot be answered as asked. Refused rather than answered wrongly. */
export class RiskIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskIndexError";
  }
}

export const RISK_INDEX_SCHEMA_VERSION = "0.1" as const;

/**
 * Whether this report carries a score.
 *
 * Exactly one of the three does. The other two exist because "we could not score this" has two
 * genuinely different causes and different answers: more coverage, or a different question.
 */
export type RiskIndexStatus =
  /** A model ran and produced a score. */
  | "sufficient"
  /** A model applies, and the scan did not check enough for it to answer. */
  | "insufficient-coverage"
  /** No model applies to this input, or none is implemented here. */
  | "unsupported";

export type RiskIndexReasonCode =
  /** This build implements no Risk Index model. */
  | "no-model"
  /** The model does not handle this kind of input. */
  | "model-not-applicable"
  /** A capability the model requires was not available on every scanned input. */
  | "missing-capability"
  /** Too few of the eligible rules actually ran for the model to answer. */
  | "insufficient-rule-coverage";

export interface RiskIndexReason {
  readonly code: RiskIndexReasonCode;
  readonly message: string;
}

/**
 * What the index was computed over.
 *
 * Stated in its own terms rather than as one number, and deliberately **not** confidence: how much
 * was checked and how sure a model is about what it found are different questions, and collapsing
 * them is how a well-covered scan of an ambiguous page ends up looking certain.
 */
export interface RiskIndexCoverage {
  /** Documents the index would be computed over. A journey contributes its steps. */
  readonly documents: number;
  /** Present only for a journey input. */
  readonly journeySteps?: number;
  /** Capabilities the model requires. Empty when no model applies. */
  readonly requiredCapabilities: readonly CapabilityId[];
  /** Required capabilities at least one scanned input could not supply. */
  readonly missingCapabilities: readonly CapabilityId[];
  /** Rolled up from every scanned input's own coverage. */
  readonly rules: {
    readonly total: number;
    readonly eligible: number;
    readonly executed: number;
    readonly skipped: number;
  };
}

/** A finding the score rests on. Identity only — the finding itself stays in its own report. */
export interface ContributingFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly fingerprint: string;
  readonly severity: Finding["severity"];
  readonly confidence: Confidence;
  /** The journey step it came from, when the input was a journey. */
  readonly stepId?: string;
}

/**
 * Every version that decides what the number means.
 *
 * `modelVersion` identifies the model that was supplied, not whether it produced a number. It is
 * filled before this function asks whether that model applies, so an unscored result — the
 * `model-not-applicable` path — still names it, and `null` means only that no model was given.
 * Read `status` for whether there is a score.
 *
 * A build that changed what a score means without changing this would produce two incomparable
 * numbers under one name, which is why the model's own version is what identifies it rather than
 * the tool's.
 */
export interface RiskIndexVersions {
  readonly schemaVersion: typeof RISK_INDEX_SCHEMA_VERSION;
  readonly modelVersion: string | null;
  readonly rulePacks: readonly RulePackReference[];
  readonly toolVersion: string;
}

export interface RiskIndexReport {
  readonly kind: "risk-index";
  readonly versions: RiskIndexVersions;
  readonly generatedAt: string;
  readonly status: RiskIndexStatus;
  /**
   * Higher is worse. `null` unless `status` is `sufficient` — never a provisional zero and never a
   * midpoint. Anything numeric returned when coverage is insufficient would be read, screenshotted,
   * and compared.
   */
  readonly score: number | null;
  /** The model's confidence in its own score. Not a coverage ratio, and null without a score. */
  readonly confidence: Confidence | null;
  /** Why there is no score. Absent exactly when there is one. */
  readonly reason?: RiskIndexReason;
  readonly coverage: RiskIndexCoverage;
  /** Sorted by fingerprint, so the order findings arrived in cannot change the report. */
  readonly contributingFindings: readonly ContributingFinding[];
  /** Never empty. What this number does not mean travels with it or not at all. */
  readonly limitations: readonly string[];
}

export type RiskIndexInput = FairUxReport | FairUxBatchReport | JourneyReport;

export interface RiskIndexModelInput {
  readonly report: RiskIndexInput;
  readonly contributingFindings: readonly ContributingFinding[];
  readonly coverage: RiskIndexCoverage;
}

export interface RiskIndexModelResult {
  readonly score: number;
  readonly confidence: Confidence;
  /** Added to the standing ones. A model says what its own number cannot answer. */
  readonly limitations?: readonly string[];
}

/**
 * A scoring model. None ships here.
 *
 * The contract decides *whether* a model may answer — the capability and rule-coverage gates below —
 * and the model decides what it needs and what the number is. Neither can be changed without the
 * other noticing: a model that changes its weights must change its version.
 */
export interface RiskIndexModel {
  readonly version: string;
  readonly requiredCapabilities?: readonly CapabilityId[];
  /** The share of eligible rules that must have run, between 0 and 1. The model's own call. */
  readonly minimumExecutedRuleRatio?: number;
  readonly appliesTo?: (report: RiskIndexInput) => boolean;
  readonly evaluate: (input: RiskIndexModelInput) => RiskIndexModelResult;
}

export interface ComputeRiskIndexOptions {
  /** The model to use. There is no default: without one the answer is `unsupported`. */
  readonly model?: RiskIndexModel;
  /** Refuse unless the model has exactly this version. */
  readonly modelVersion?: string;
  readonly toolVersion?: string;
  readonly now?: () => Date;
}

/**
 * Carried on every report, scored or not.
 *
 * The first line is the one this whole milestone is ordered around: M3 exists so that a number can
 * never be reported without the coverage beside it, and this is where that promise is kept for a
 * reader who only ever sees the index.
 */
const STANDING_LIMITATIONS: readonly string[] = Object.freeze([
  "A Risk Index is not a safety, legal, or compliance verdict, and no score is a statement that a product is fair.",
  "It describes the inputs it was given. Anything not scanned is not represented, and coverage says what that was.",
  "Zero findings is not zero risk: it is the absence of what these rules can detect.",
]);

/**
 * The limitation a filtered report has to carry, named file by file.
 *
 * Everything a Risk Index computes reads `findings`, which is what a run *reported*. A
 * `--suppress` or `--baseline` file subtracts before this runs, so a score computed after one is a
 * score of what was left — and an empty `contributingFindings` after a baseline that removed twelve
 * findings is indistinguishable from a clean page. The report says so rather than leaving it to
 * whoever compares two runs, because "zero findings is not zero risk" is a general caution and this
 * is a specific fact about this report.
 *
 * `limitations` and not `reason`: the number, when there is one, is still a number about the
 * findings it was given. What changed is what it is a number *of*.
 */
function externalFilterLimitations(report: RiskIndexInput): readonly string[] {
  const filters = "externalFilters" in report ? report.externalFilters : undefined;
  return (filters ?? []).map(
    (record) =>
      `A ${record.kind} file removed ${record.detected.total - record.reported.total} finding(s) ` +
      `before this was computed: ${record.file} (${record.digest}). This describes what was ` +
      "reported, not what was detected.",
  );
}

function isBatch(report: RiskIndexInput): report is FairUxBatchReport {
  return report.kind === "batch";
}

function isJourney(report: RiskIndexInput): report is JourneyReport {
  return report.kind === "journey";
}

/**
 * The findings a score would rest on, as identity only.
 *
 * Sorted by fingerprint and then id: two scans that differ only in the order rules ran must produce
 * the same report, or the number is noise rather than a measurement.
 */
function collectContributingFindings(report: RiskIndexInput): readonly ContributingFinding[] {
  const entries: ContributingFinding[] = [];
  const push = (finding: Finding, stepId?: string): void => {
    entries.push(
      Object.freeze({
        findingId: finding.id,
        ruleId: finding.ruleId,
        fingerprint: finding.fingerprint,
        severity: finding.severity,
        confidence: finding.confidence,
        ...(stepId !== undefined ? { stepId } : {}),
      }),
    );
  };

  if (isBatch(report)) {
    for (const entry of report.reports) for (const finding of entry.findings) push(finding);
  } else if (isJourney(report)) {
    for (const step of report.steps) {
      for (const finding of step.report.findings) push(finding, step.id);
    }
    for (const finding of report.findings) {
      push(finding, finding.evidence[0]?.stepId);
    }
  } else {
    for (const finding of report.findings) push(finding);
  }

  return Object.freeze(
    entries.sort((left, right) => {
      if (left.fingerprint !== right.fingerprint) {
        return left.fingerprint < right.fingerprint ? -1 : 1;
      }
      return left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0;
    }),
  );
}

function emptyRuleCoverage(): RiskIndexCoverage["rules"] {
  return { total: 0, eligible: 0, executed: 0, skipped: 0 };
}

function addRuleCoverage(
  into: { total: number; eligible: number; executed: number; skipped: number },
  from: FairUxReport["coverage"],
): void {
  if (!from) return;
  into.total += from.summary.total;
  into.eligible += from.summary.eligible;
  into.executed += from.summary.executed;
  into.skipped += from.summary.skipped;
}

/** Capabilities available on every scanned input, which is the only honest reading for a total. */
function availableAcrossInputs(report: RiskIndexInput): ReadonlySet<CapabilityId> | undefined {
  const perInput: (readonly CapabilityId[])[] = [];
  if (isBatch(report)) {
    for (const entry of report.reports) {
      if (entry.coverage) perInput.push(entry.coverage.capabilities.available);
    }
  } else if (isJourney(report)) {
    for (const step of report.steps) {
      if (step.report.coverage) perInput.push(step.report.coverage.capabilities.available);
    }
    if (report.coverage) perInput.push(report.coverage.capabilities.available);
  } else if (report.coverage) {
    perInput.push(report.coverage.capabilities.available);
  }
  if (perInput.length === 0) return undefined;
  const sets = perInput.map((list) => new Set(list));
  const first = sets[0] as Set<CapabilityId>;
  return new Set([...first].filter((capability) => sets.every((set) => set.has(capability))));
}

function buildCoverage(
  report: RiskIndexInput,
  model: RiskIndexModel | undefined,
  available: ReadonlySet<CapabilityId> | undefined,
): RiskIndexCoverage {
  const rules = emptyRuleCoverage();
  const mutableRules = { ...rules };
  let documents = 0;

  if (isBatch(report)) {
    documents = report.reports.length;
    for (const entry of report.reports) addRuleCoverage(mutableRules, entry.coverage);
  } else if (isJourney(report)) {
    documents = report.steps.length;
    for (const step of report.steps) addRuleCoverage(mutableRules, step.report.coverage);
    addRuleCoverage(mutableRules, report.coverage);
  } else {
    documents = 1;
    addRuleCoverage(mutableRules, report.coverage);
  }

  const required = sortCapabilityIds(model?.requiredCapabilities ?? []);
  const missing =
    required.length === 0
      ? []
      : available === undefined
        ? required
        : missingCapabilities(required, available);

  return Object.freeze({
    documents,
    ...(isJourney(report) ? { journeySteps: report.steps.length } : {}),
    requiredCapabilities: required,
    missingCapabilities: missing,
    rules: Object.freeze(mutableRules),
  });
}

function rulePacksOf(report: RiskIndexInput): readonly RulePackReference[] {
  if (isJourney(report)) return report.rulePacks ?? [];
  return report.rulePacks ?? [];
}

function unscored(
  base: Omit<RiskIndexReport, "status" | "score" | "confidence" | "reason">,
  status: Exclude<RiskIndexStatus, "sufficient">,
  reason: RiskIndexReason,
): RiskIndexReport {
  return Object.freeze({
    ...base,
    status,
    // Both null, always. A caller that finds a number here found a bug, not a cautious estimate.
    score: null,
    confidence: null,
    reason,
  });
}

/**
 * Compute a Risk Index for a report.
 *
 * Every path that cannot produce a score returns one without a number and with a reason. There is no
 * path that returns a placeholder, because a placeholder is what gets quoted.
 */
export function computeRiskIndex(
  report: RiskIndexInput,
  options: ComputeRiskIndexOptions = {},
): RiskIndexReport {
  const model = options.model;
  if (options.modelVersion !== undefined && model?.version !== options.modelVersion) {
    // Refused rather than answered with whatever model happens to be here. A caller asking for a
    // specific model is asking for a specific meaning of the number.
    throw new RiskIndexError(
      `unknown risk index model version: ${options.modelVersion}${
        model ? ` (this build has ${model.version})` : " (this build has no model)"
      }`,
    );
  }

  const now = options.now ?? (() => new Date());
  const contributingFindings = collectContributingFindings(report);
  const available = availableAcrossInputs(report);
  const coverage = buildCoverage(report, model, available);
  const base = {
    kind: "risk-index" as const,
    versions: Object.freeze({
      schemaVersion: RISK_INDEX_SCHEMA_VERSION,
      modelVersion: model?.version ?? null,
      rulePacks: rulePacksOf(report),
      toolVersion: options.toolVersion ?? "0.0.0",
    }),
    generatedAt: now().toISOString(),
    coverage,
    contributingFindings,
    limitations: Object.freeze([...STANDING_LIMITATIONS, ...externalFilterLimitations(report)]),
  };

  if (!model) {
    return unscored(base, "unsupported", {
      code: "no-model",
      message: "no Risk Index model is implemented in this build",
    });
  }
  if (model.appliesTo && !model.appliesTo(report)) {
    return unscored(base, "unsupported", {
      code: "model-not-applicable",
      message: `model ${model.version} does not handle a ${report.kind} report`,
    });
  }
  if (coverage.missingCapabilities.length > 0) {
    return unscored(base, "insufficient-coverage", {
      code: "missing-capability",
      message: `model ${model.version} requires ${coverage.missingCapabilities.join(", ")}, which not every scanned input supplied`,
    });
  }
  const ratio = model.minimumExecutedRuleRatio;
  if (ratio !== undefined && coverage.rules.eligible > 0) {
    const executedRatio = coverage.rules.executed / coverage.rules.eligible;
    if (executedRatio < ratio) {
      return unscored(base, "insufficient-coverage", {
        code: "insufficient-rule-coverage",
        message: `model ${model.version} requires ${ratio} of eligible rules to run; ${coverage.rules.executed} of ${coverage.rules.eligible} did`,
      });
    }
  }

  const result = model.evaluate({ report, contributingFindings, coverage });
  if (!Number.isFinite(result?.score)) {
    // A model that answers with something that is not a number has failed, and failing loudly is the
    // only option that does not put a nonsense value into a report.
    throw new RiskIndexError(`model ${model.version} returned a non-numeric score`);
  }
  return Object.freeze({
    ...base,
    status: "sufficient",
    score: result.score,
    confidence: result.confidence,
    limitations: Object.freeze([...base.limitations, ...(result.limitations ?? [])]),
  });
}

/** The standing limitations, exported so a surface can show them without a computed report. */
export function riskIndexStandingLimitations(): readonly string[] {
  return STANDING_LIMITATIONS;
}
