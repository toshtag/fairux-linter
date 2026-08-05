export type Runtime = "html" | "dom" | "ast" | "figma";
export type Severity = "info" | "low" | "medium" | "high";
export type Confidence = "low" | "medium" | "high";

export type BuiltinCategory =
  | "consent"
  | "subscription"
  | "cancellation"
  | "scarcity"
  | "hidden-cost"
  | "visual-asymmetry"
  | "privacy"
  | "accessibility"
  | "obstruction";

export type CategoryId = BuiltinCategory | `${string}/${string}`;
export type Category = CategoryId;

export type RuleMaturity = "draft" | "experimental" | "stable" | "deprecated";

export type BuiltinCapabilityId =
  | "structure"
  | "text"
  | "attributes"
  | "source-location"
  | "source-range"
  | "dom-state"
  | "style-hints"
  | "computed-style"
  | "viewport"
  | "interaction"
  | "journey"
  | "form"
  | "network";

export type CapabilityId = BuiltinCapabilityId | `${string}/${string}`;

export type EvidenceRequirement =
  | "presence"
  | "absence"
  | "text-match"
  | "attribute-state"
  | "comparison"
  | "runtime-state"
  | "sequence"
  | "network-observation";

export type JurisdictionId = string;
export type OfficialSourceId = `${string}/${string}`;
export type ReadonlyNonEmptyArray<T> = readonly [T, ...T[]];

export interface OfficialSource {
  readonly id: OfficialSourceId;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly jurisdictions?: ReadonlyNonEmptyArray<JurisdictionId>;
  readonly reviewedAt: string;
}

export interface RuleDeprecation {
  readonly since: string;
  readonly reason: string;
  readonly replacementRuleId?: string;
  readonly removalTarget?: string;
}

export interface CategoryDefinition {
  readonly id: CategoryId;
  readonly title: string;
  readonly description?: string;
  readonly parentId?: CategoryId;
}

export type Locale = string;

export type NodeLocator =
  | { type: "css"; value: string }
  | { type: "path"; value: number[] }
  | { type: "ast"; file: string; startLine: number; startColumn: number }
  | { type: "figma"; nodeId: string };

export interface SourceLocation {
  file?: string;
  startLine?: number;
  startColumn?: number;
}

/**
 * A range of source text, and exactly what the source says there. Positions follow `TextEdit`:
 * 1-based lines and columns, end exclusive.
 */
export interface SourceSpan {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly text: string;
}

export interface AccessibilityInfo {
  name?: string;
  nameSource?: "aria-label" | "aria-labelledby" | "alt" | "text" | "unknown";
}

/** Rendered geometry in CSS pixels relative to the viewport. Integers, for report stability. */
export interface VisualBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What a rendering engine resolved for this node — the values in effect, as opposed to the class
 * names and inline declarations `style-hints` carries. Absent means nobody measured it.
 */
export interface VisualFacts {
  /** Resolved values for a fixed, documented set of properties, keyed by CSS property name. */
  readonly computedStyle?: Readonly<Record<string, string>>;
  readonly box?: VisualBox;
  /** Whether any part of the box intersects the viewport at the moment of the scan. */
  readonly inViewport?: boolean;
}

/** Constraint-validation states a control can be in, as the platform names them. */
export type FormConstraint =
  | "valueMissing"
  | "typeMismatch"
  | "patternMismatch"
  | "tooLong"
  | "tooShort"
  | "rangeUnderflow"
  | "rangeOverflow"
  | "stepMismatch"
  | "badInput"
  | "customError";

/**
 * What a live form knows about a control and its markup does not: whether it participates in
 * validation, what is failing right now, and which form owns it. A snapshot, like the tree beside it.
 */
export interface FormFacts {
  readonly willValidate: boolean;
  readonly failedConstraints: readonly FormConstraint[];
  readonly formNodeId?: string;
}

export interface UiNode {
  id: string;
  parentId?: string;
  tag: string;
  role?: string;
  attributes: Record<string, string | true>;
  directText: string;
  subtreeText: string;
  normalizedText: string;
  accessibility?: AccessibilityInfo;
  children: UiNode[];
  locator: NodeLocator;
  source?: SourceLocation;
  /**
   * Where each attribute is written, keyed as `attributes` keys them, starting at the whitespace
   * before the attribute. Present only where an adapter was asked for `source-range`.
   */
  attributeRanges?: Readonly<Record<string, SourceSpan>>;
  /** What a rendering engine resolved for this node, when an adapter was asked to read it. */
  visual?: VisualFacts;
  /** What a live form knows about this control, when an adapter was asked to read it. */
  form?: FormFacts;
}

export type BuiltinPageContext =
  | "pricing"
  | "checkout"
  | "subscription"
  | "account-settings"
  | "consent"
  | "marketing"
  | "unknown";

export type PageContextId = BuiltinPageContext | `${string}/${string}`;
export type PageContext = PageContextId;

export interface PageContextDefinition {
  readonly id: PageContextId;
  readonly title: string;
  readonly description?: string;
}

export interface PageContextSignal {
  context: PageContext;
  confidence: Confidence;
  evidence?: readonly Evidence[];
}

export interface UiDocument {
  root: UiNode;
  runtime: Runtime;
  all(): UiNode[];
  findAll(predicate: (node: UiNode) => boolean): UiNode[];
  getNode(id: string): UiNode | undefined;
  metadata?: {
    file?: string;
    title?: string;
    url?: string;
    locale?: Locale | "unknown";
    containsShadow?: boolean;
    /** Lowercase hex SHA-256 of the source, supplied by whoever read it. */
    sourceChecksum?: string;
  };
  pageContexts: readonly PageContextSignal[];
  /**
   * Comments the adapter found, with their line numbers, for inline suppression directives.
   *
   * Present only where the input has both — static HTML and JSX/TSX. A live DOM has comments but no
   * stable lines and a Figma document has neither, so both leave this absent rather than supplying
   * something that looks usable and is not.
   */
  comments?: readonly DocumentComment[];
  /**
   * What this document can answer for, when it differs from its runtime's baseline.
   *
   * Absent means the baseline for the runtime — what the adapter for it supplies. An empty array is
   * a claim, not a gap: it says this document backs nothing, and every rule is skipped for it.
   */
  capabilities?: readonly CapabilityId[];
}

/** A comment an adapter found, with the line it sits on (1-based). */
export interface DocumentComment {
  readonly text: string;
  readonly startLine: number;
}

/** One inline `fairux-disable-next-line` that applied, with the reason its author gave. */
export interface AppliedSuppression {
  readonly ruleId: string;
  readonly reason: string;
  readonly line: number;
}

/** An inline directive that did not do what its author intended. */
export interface SuppressionDiagnostic {
  readonly line: number;
  readonly kind: "malformed" | "unused";
  readonly message: string;
}

export interface Evidence {
  locator?: NodeLocator;
  text?: string;
  snippet?: string;
  source?: SourceLocation;
  /** The journey step this evidence came from. Present only on findings from a journey scan. */
  stepId?: string;
}

export interface Finding {
  id: string;
  fingerprint: string;
  batchOccurrenceId?: string;
  ruleId: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  title: string;
  description: string;
  evidence: Evidence[];
  whyItMatters: string;
  recommendation: string;
  references?: readonly string[];
  /** A proposed edit, when the rule could produce one. Absent is not a defect. */
  remediation?: Remediation;
}

/** Whether applying this edit needs a human first. */
export type RemediationSafety = "safe" | "review-required";

/**
 * Where the proposed edit came from. An `ai` remediation can never be `safe` — that is enforced in
 * validation rather than promised in a document.
 */
export type RemediationOrigin = "rule" | "ai";

/** One replacement in one file. `expected` is what the range must currently contain. */
export interface TextEdit {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly expected: string;
  readonly replacement: string;
}

/** A proposed fix for one finding, in one file. Nothing applies one yet. */
export interface Remediation {
  readonly id: string;
  readonly origin: RemediationOrigin;
  readonly safety: RemediationSafety;
  readonly title: string;
  readonly description: string;
  /** Why it is safe, or why it is not. Required for both. */
  readonly rationale: string;
  readonly file: string;
  /** SHA-256 of the file contents the edits were computed against, lowercase hex. */
  readonly fileChecksum: string;
  readonly edits: ReadonlyNonEmptyArray<TextEdit>;
}

// ── Optional AI augmentation ────────────────────────────────────────────────

export type AiFailureCode = "provider-error" | "timeout" | "invalid-output";

export interface AiFailure {
  readonly code: AiFailureCode;
  readonly message: string;
}

/** Where an observation came from. Every field is required — an unattributable one cannot be checked. */
export interface AiProvenance {
  readonly provider: string;
  readonly model: string;
  readonly generatedAt: string;
  /** SHA-256 of the payload that was sent. */
  readonly inputChecksum: string;
}

/**
 * One thing an AI said about the page. Deliberately not a `Finding`: no fingerprint, no rule id, no
 * severity, because those belong to things a baseline can track and a build can fail on.
 */
export interface AiObservation {
  readonly id: string;
  readonly summary: string;
  readonly detail: string;
  /** The provider's own claim. Not comparable with a rule's confidence, and never used as one. */
  readonly statedConfidence?: string;
  readonly relatedRuleId?: string;
  readonly provenance: AiProvenance;
}

export interface AiAugmentation {
  readonly observations: readonly AiObservation[];
  readonly failures: readonly AiFailure[];
  /** Always true, as a field a consumer can assert on. */
  readonly advisory: true;
}

/** What a provider is allowed to receive. An allowlist: nothing else leaves the machine. */
export interface AiPayload {
  readonly text: string;
  readonly tags: readonly string[];
  readonly pageContexts: readonly string[];
}

export interface AiProvider {
  readonly name: string;
  readonly observe: (payload: AiPayload) => Promise<readonly AiObservation[]>;
}

export interface AiAugmentationOptions {
  readonly provider: AiProvider;
  readonly timeoutMs: number;
}

export interface RulePackReference {
  readonly id: string;
  readonly version: string;
}

/** Why a rule the scan knew about did not run. */
export type RuleSkipReason = "not-enabled" | "missing-capability" | "page-context-mismatch";

/** What one rule did on one scan. */
export interface RuleCoverage {
  readonly ruleId: string;
  readonly executed: boolean;
  /** Present exactly when `executed` is false. */
  readonly skipReason?: RuleSkipReason;
  /** Required capabilities the input could not supply. Present only with `missing-capability`. */
  readonly missingCapabilities?: readonly CapabilityId[];
  /** Optional capabilities the rule ran without — a weaker pass, reported as one. */
  readonly missingOptionalCapabilities?: readonly CapabilityId[];
}

export interface ScanCapabilityCoverage {
  readonly available: readonly CapabilityId[];
  /** The built-in vocabulary plus anything the rule set asked for, minus what was available. */
  readonly unavailable: readonly CapabilityId[];
}

export interface ScanCoverageSummary {
  readonly total: number;
  readonly eligible: number;
  readonly executed: number;
  readonly skipped: number;
}

/**
 * What a scan was able to check — reported beside what it found, never instead of it.
 *
 * A description, not a score: it says which rules ran, which did not, and why. It does not say the
 * executed rules were right, nor that an empty findings list means a page is fair.
 */
export interface ScanCoverage {
  readonly capabilities: ScanCapabilityCoverage;
  readonly summary: ScanCoverageSummary;
  readonly rules: readonly RuleCoverage[];
}

export interface FairUxReport {
  kind: "single";
  schemaVersion: "0.1";
  toolVersion: string;
  generatedAt: string;
  input: { file?: string; runtime: Runtime };
  rulePacks?: readonly RulePackReference[];
  summary: { total: number; bySeverity: Record<Severity, number> };
  /** What the scan was able to check. Absent is not full coverage — tolerate it. */
  coverage?: ScanCoverage;
  findings: Finding[];
  /** Findings an inline directive accepted. Absent when none did — never an empty array. */
  suppressed?: readonly AppliedSuppression[];
  /**
   * Advisory AI output, when a provider was configured and answered. Never merged into `findings`.
   */
  aiAugmentation?: AiAugmentation;
  /** Directives that were malformed or matched nothing. Absent when there are none. */
  suppressionDiagnostics?: readonly SuppressionDiagnostic[];
}

export interface FairUxBatchReport {
  kind: "batch";
  schemaVersion: "0.1";
  toolVersion: string;
  generatedAt: string;
  inputs: Array<{
    file?: string;
    runtime: Runtime;
    figmaFile?: string;
  }>;
  rulePacks?: readonly RulePackReference[];
  summary: {
    total: number;
    bySeverity: Record<Severity, number>;
    byRuntime?: Record<Runtime, { total: number; bySeverity: Record<Severity, number> }>;
  };
  reports: Array<{
    input: {
      file?: string;
      runtime: Runtime;
    };
    summary: { total: number; bySeverity: Record<Severity, number> };
    /** Per-input, never rolled up: two inputs in one batch can have different capabilities. */
    coverage?: ScanCoverage;
    findings: Finding[];
  }>;
}

/** How the user got from the previous step to this one. Coarse on purpose — no driver detail. */
export interface JourneyTransition {
  readonly kind: "navigation" | "in-page" | "unknown";
  readonly note?: string;
}

/** One step of a journey: a document the caller already has, and where it sits in the flow. */
export interface JourneyStep {
  readonly id: string;
  readonly order: number;
  readonly document: UiDocument;
  readonly url?: string;
  readonly location?: string;
  readonly actionLabel?: string;
  readonly transition?: JourneyTransition;
}

export interface JourneyInput {
  readonly steps: readonly JourneyStep[];
}

export interface JourneyStepView {
  readonly id: string;
  readonly order: number;
  readonly doc: UiDocument;
  readonly url?: string;
  readonly location?: string;
  readonly actionLabel?: string;
  readonly transition?: JourneyTransition;
}

export interface JourneyView {
  readonly steps: readonly JourneyStepView[];
}

export interface CreateJourneyFindingInput extends CreateFindingInput {
  /** The step this finding is anchored to. Required: a flow-wide finding cannot be acted on. */
  readonly stepId: string;
}

export interface JourneyRuleContext {
  readonly journey: JourneyView;
  readonly locale: Locale;
  readonly text: TextMatcher;
  getDictionary(): PatternGroup;
  createFinding(input: CreateJourneyFindingInput): Finding;
}

/** A rule that reads the whole flow. Its `requiredCapabilities` must include `journey`. */
export interface JourneyRule {
  readonly meta: RuleMeta;
  readonly evaluate: (journey: JourneyView, ctx: JourneyRuleContext) => Finding[];
}

export interface JourneyStepReport {
  readonly id: string;
  readonly order: number;
  readonly url?: string;
  readonly location?: string;
  readonly report: FairUxReport;
}

/**
 * Every step's own report, plus the findings that exist only across steps. The two layers are
 * disjoint: a journey finding is never a copy of a step's own.
 */
export interface JourneyReport {
  kind: "journey";
  schemaVersion: "0.1";
  toolVersion: string;
  generatedAt: string;
  steps: readonly JourneyStepReport[];
  findings: readonly Finding[];
  summary: { total: number; bySeverity: Record<Severity, number> };
  /** Rolled up from the steps. Disjoint from `summary`, so the two may be added. */
  stepSummary: { total: number; bySeverity: Record<Severity, number> };
  coverage?: ScanCoverage;
  rulePacks?: readonly RulePackReference[];
}

// ── Risk Index ──────────────────────────────────────────────────────────────

export type RiskIndexStatus = "sufficient" | "insufficient-coverage" | "unsupported";

export type RiskIndexReasonCode =
  | "no-model"
  | "model-not-applicable"
  | "missing-capability"
  | "insufficient-rule-coverage";

export interface RiskIndexReason {
  readonly code: RiskIndexReasonCode;
  readonly message: string;
}

/**
 * What the index was computed over. Deliberately **not** confidence: how much was checked and how
 * sure a model is about what it found are different questions.
 */
export interface RiskIndexCoverage {
  readonly documents: number;
  readonly journeySteps?: number;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly missingCapabilities: readonly CapabilityId[];
  readonly rules: {
    readonly total: number;
    readonly eligible: number;
    readonly executed: number;
    readonly skipped: number;
  };
}

/** A finding the score rests on. Identity only — the finding stays in its own report. */
export interface ContributingFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly fingerprint: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly stepId?: string;
}

export interface RiskIndexVersions {
  readonly schemaVersion: "0.1";
  /**
   * Identifies the model supplied for this calculation.
   *
   * Non-null even when that model could not score the input — `model-not-applicable` names it and
   * leaves `score` null. Null only when no model was supplied.
   */
  readonly modelVersion: string | null;
  readonly rulePacks: readonly RulePackReference[];
  readonly toolVersion: string;
}

export interface RiskIndexReport {
  readonly kind: "risk-index";
  readonly versions: RiskIndexVersions;
  readonly generatedAt: string;
  readonly status: RiskIndexStatus;
  /** Higher is worse. `null` unless `status` is `sufficient` — never a placeholder. */
  readonly score: number | null;
  /** The model's confidence in its own score. Not a coverage ratio. */
  readonly confidence: Confidence | null;
  /** Why there is no score. Absent exactly when there is one. */
  readonly reason?: RiskIndexReason;
  readonly coverage: RiskIndexCoverage;
  readonly contributingFindings: readonly ContributingFinding[];
  /** Never empty. */
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
  readonly limitations?: readonly string[];
}

/**
 * A scoring model.
 *
 * Two ship with this package — `fairuxRiskIndexModel` and `fairuxRiskIndexModelV2` — and a
 * compatible custom model is accepted in their place. A model that changes what its score means
 * must change its version, because two scores are comparable when their versions match and not
 * otherwise.
 */
export interface RiskIndexModel {
  readonly version: string;
  readonly requiredCapabilities?: readonly CapabilityId[];
  readonly minimumExecutedRuleRatio?: number;
  readonly appliesTo?: (report: RiskIndexInput) => boolean;
  readonly evaluate: (input: RiskIndexModelInput) => RiskIndexModelResult;
}

export interface ComputeRiskIndexOptions {
  readonly model?: RiskIndexModel;
  /** Refuse unless the model has exactly this version. */
  readonly modelVersion?: string;
  readonly toolVersion?: string;
  readonly now?: () => Date;
}

export interface RuleMeta {
  readonly id: string;
  readonly title: string;
  readonly category: Category;
  readonly defaultSeverity: Severity;
  readonly defaultConfidence: Confidence;
  readonly defaultEnabled: boolean;
  readonly experimental?: boolean;
  readonly appliesTo?: readonly PageContext[];
  readonly appliesToMinConfidence?: Confidence;
  readonly tags: readonly string[];
  readonly version: string;
  readonly references?: readonly string[];
  readonly maturity: RuleMaturity;
  readonly requiredCapabilities: ReadonlyNonEmptyArray<CapabilityId>;
  readonly optionalCapabilities?: ReadonlyNonEmptyArray<CapabilityId>;
  readonly evidenceRequirements: ReadonlyNonEmptyArray<EvidenceRequirement>;
  readonly jurisdictions?: ReadonlyNonEmptyArray<JurisdictionId>;
  readonly officialSources?: ReadonlyNonEmptyArray<OfficialSource>;
  readonly knownLimitations?: ReadonlyNonEmptyArray<string>;
  readonly deprecation?: RuleDeprecation;
}

export interface TextMatcher {
  normalize(text: string): string;
  hasAny(text: string, patterns: readonly RegExp[]): boolean;
  findAny(text: string, patterns: readonly RegExp[]): RegExpMatchArray | null;
}

export interface CreateFindingInput {
  evidence: Evidence[];
  description: string;
  whyItMatters: string;
  recommendation: string;
  title?: string;
  severity?: Severity;
  confidence?: Confidence;
  references?: string[];
  fingerprintText?: string;
  remediation?: Remediation;
}

export type PatternGroup = Readonly<Record<string, readonly RegExp[]>>;
export type KeywordDictionary = Readonly<Partial<Record<Locale, PatternGroup>>>;

export interface NodeQueries {
  ancestors(node: UiNode): UiNode[];
  descendants(node: UiNode): UiNode[];
  closest(node: UiNode, predicate: (n: UiNode) => boolean): UiNode | undefined;
  nearbyText(node: UiNode, levels?: number): string;
}

export interface UiSemantics {
  isButtonLike(node: UiNode): boolean;
  isLinkLike(node: UiNode): boolean;
  isInput(node: UiNode): boolean;
  getControlLabel(node: UiNode): string;
}

export interface RuleContext {
  readonly doc: UiDocument;
  readonly locale: Locale;
  readonly queries: NodeQueries;
  readonly semantics: UiSemantics;
  readonly text: TextMatcher;
  getDictionary(): PatternGroup;
  getPageContexts(): readonly PageContextSignal[];
  createFinding(input: CreateFindingInput): Finding;
}

export interface Rule {
  readonly meta: RuleMeta;
  readonly evaluate: (doc: UiDocument, ctx: RuleContext) => Finding[];
}

export type EngineApiVersion = "1";

export interface RulePackMeta {
  readonly id: string;
  readonly version: string;
  readonly engineApiVersion: EngineApiVersion;
  readonly title: string;
  readonly description?: string;
  readonly status: "stable" | "experimental";
}

export interface RulePackTaxonomy {
  readonly categories?: readonly CategoryDefinition[];
  readonly pageContexts?: readonly PageContextDefinition[];
}

export interface ComposedTaxonomy {
  readonly categories: readonly CategoryDefinition[];
  readonly pageContexts: readonly PageContextDefinition[];
}

export interface RulePack {
  readonly meta: RulePackMeta;
  readonly taxonomy?: RulePackTaxonomy;
  readonly rules: readonly Rule[];
  /** Rules that read the whole flow. Their ids share one namespace with `rules`. */
  readonly journeyRules?: readonly JourneyRule[];
  readonly dictionary?: KeywordDictionary;
}

export interface ComposedRuleSet {
  readonly rules: readonly Rule[];
  readonly journeyRules: readonly JourneyRule[];
  readonly dictionary: KeywordDictionary;
  readonly rulePacks: readonly RulePackMeta[];
  readonly taxonomy: ComposedTaxonomy;
}

export interface RuleOverride {
  readonly enabled?: boolean;
  readonly severity?: Severity;
}

export interface ScanOptions {
  locale?: Locale;
  dictionary?: KeywordDictionary;
  includeExperimental?: boolean;
  ruleOverrides?: Readonly<Record<string, boolean | RuleOverride>>;
  toolVersion?: string;
  rulePacks?: readonly RulePackReference[];
  now?: () => Date;
}

export interface FairuxConfig {
  configVersion?: 1;
  includeExperimental?: boolean;
  rules?: Record<string, boolean | RuleOverride>;
}

export interface CreateScannerOptions {
  readonly rulePacks: readonly RulePack[];
  readonly includeExperimental?: boolean;
  readonly ruleOverrides?: Readonly<Record<string, boolean | RuleOverride>>;
  readonly severityOverrides?: Readonly<Record<string, Severity>>;
  readonly locale?: Locale;
  readonly toolVersion?: string;
  readonly now?: () => Date;
}

export interface FairuxScanner {
  readonly rulePacks: readonly RulePackMeta[];
  readonly taxonomy: ComposedTaxonomy;
  readonly scan: (document: UiDocument) => FairUxReport;
  /** Scan a flow. Separate from `scan` on purpose — see `JourneyInput`. */
  readonly scanJourney: (input: JourneyInput) => JourneyReport;
}

export interface ScannerPolicyOptions {
  readonly rulePacks?: readonly RulePack[];
  readonly includeExperimental?: boolean;
  readonly ruleOverrides?: Readonly<Record<string, boolean | RuleOverride>>;
  readonly severityOverrides?: Readonly<Record<string, Severity>>;
  readonly locale?: Locale;
  readonly toolVersion?: string;
  readonly now?: () => Date;
}
