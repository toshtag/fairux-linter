/**
 * FairUX Core — type contracts.
 *
 * These types are the boundary every surface speaks, whichever runtimes exist — `Runtime` below is
 * the list, and adapters and manifests are the rest of the answer. They are deliberately
 * runtime-agnostic: no DOM, no Node, no parser types leak in here.
 */

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

/** Where a node/finding lives. CSS is just one locator kind, never the center of the model. */
export type NodeLocator =
  | { type: "css"; value: string }
  | { type: "path"; value: number[] }
  | { type: "ast"; file: string; startLine: number; startColumn: number }
  | { type: "figma"; nodeId: string };

/**
 * Where in the source something is, as far as the adapter that read it knows.
 *
 * The end is optional and separate from the start because not every adapter has one and an absent
 * end is not a zero-length range — a consumer that finds `endLine` missing has to choose its own
 * fallback rather than be handed a wrong one.
 *
 * It exists because the two consumers that draw a range had nothing to draw. The VS Code extension
 * underlined from the start column to the end of that line, which is wrong in both directions: an
 * element spanning four lines was marked on one, and an element with other markup after it on the
 * same line dragged the squiggle across code it has nothing to do with.
 *
 * Positions are 1-based and the end is exclusive, matching `SourceSpan` and `TextEdit` — one
 * convention for every position in this schema.
 */
export interface SourceLocation {
  file?: string;
  startLine?: number;
  startColumn?: number;
  /** Exclusive. Present only when the adapter knew it; absent is "unknown", not "empty". */
  endLine?: number;
  endColumn?: number;
}

/**
 * A range of source text, and exactly what the source says there.
 *
 * Positions follow `TextEdit`: 1-based lines and columns, end exclusive. `text` is the source
 * between them, and it is the field that makes the range usable — a rule can fill
 * `TextEdit.expected` from it without reading the file, which is the whole point, because
 * `@fairux/core` and `@fairux/rules` are browser-safe and have no filesystem to read.
 */
export interface SourceSpan {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly text: string;
}

/**
 * Best-effort accessible name. NOT a full WAI-ARIA Accessible Name Computation —
 * adapters fill what they cheaply can and record where it came from.
 */
export interface AccessibilityInfo {
  name?: string;
  nameSource?: "aria-label" | "aria-labelledby" | "alt" | "text" | "unknown";
}

/**
 * Rendered geometry, in CSS pixels relative to the viewport.
 *
 * Integers: sub-pixel values differ with zoom, device pixel ratio, and font rendering, and a report
 * that moved between two scans of an unchanged page would be reporting the browser rather than the
 * page.
 */
export interface VisualBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What a rendering engine resolved for this node — the values actually in effect, as opposed to the
 * class names and inline declarations `style-hints` carries.
 *
 * Only an adapter with a live rendering engine can fill this, and only when asked: reading it forces
 * layout. A node without it is not a node with default styling; it is a node nobody measured.
 */
export interface VisualFacts {
  /**
   * Resolved values for a fixed, documented set of properties, keyed by CSS property name.
   *
   * Fixed rather than complete on purpose: a full CSSOM snapshot per node is enormous, and its
   * contents differ between engines, so a report built from one would not be comparable with itself.
   */
  readonly computedStyle?: Readonly<Record<string, string>>;
  readonly box?: VisualBox;
  /** Whether any part of the box intersects the viewport at the moment of the scan. */
  readonly inViewport?: boolean;
}

/**
 * Constraint-validation states a control can be in, as the platform names them.
 *
 * Only the ones currently unsatisfied are recorded. A control satisfying every constraint has an
 * empty list, which is a different statement from a control that does not participate in validation
 * at all — the distinction `willValidate` carries.
 */
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
 * What a live form knows about a control and its markup does not.
 *
 * `required` in the markup says what the author asked for. Whether the control participates in
 * validation at all, whether it is failing right now, and which form owns it are answers only a
 * rendering engine has — a `required` input inside a `novalidate` form is not a validated field, and
 * nothing in the attributes says so.
 *
 * Like the tree beside it, this is a snapshot: the unsatisfied constraints reflect what the user had
 * typed at the moment of the scan, not a property of the form's design.
 */
export interface FormFacts {
  /** Whether the control is a candidate for constraint validation right now. */
  readonly willValidate: boolean;
  /** Constraints currently unsatisfied. Empty when the control is valid or does not validate. */
  readonly failedConstraints: readonly FormConstraint[];
  /** The `UiNode.id` of the form that owns this control, when it has one. */
  readonly formNodeId?: string;
}

/**
 * Normalized UI node. A tree of these is the only thing rules ever see.
 * `parentId` (not a `parent` reference) keeps the structure acyclic and serializable.
 */
export interface UiNode {
  id: string;
  parentId?: string;
  tag: string;
  role?: string;
  /** Boolean HTML attributes (e.g. `checked`) are represented as `true`. */
  attributes: Record<string, string | true>;
  /** Text directly owned by this node (excludes descendants). */
  directText: string;
  /** Text of this node and all descendants. */
  subtreeText: string;
  /** `subtreeText` after NFKC → lowercase → whitespace-collapse → trim. */
  normalizedText: string;
  accessibility?: AccessibilityInfo;
  children: UiNode[];
  locator: NodeLocator;
  source?: SourceLocation;
  /**
   * Where each of this node's attributes is written, keyed exactly as `attributes` keys them.
   *
   * A range starts at the whitespace separating the attribute from what precedes it rather than at
   * the attribute name, because the only edit derivable from the model alone is removing the
   * attribute — and removing `checked` from `<input type="checkbox" checked>` without its leading
   * space leaves a stray one behind.
   *
   * Beside `source` rather than inside it. `SourceLocation` is also what a finding's evidence
   * carries, and evidence is a pointer for a reader, not a substrate for an edit; a report that
   * shipped every attribute position of every flagged node would be paying for an edit nobody asked
   * it to make.
   *
   * Present only where an adapter was asked for it, and a rule that reads it must declare
   * `source-range`. A node without it is not a node whose attributes are unlocatable; it is a node
   * nobody recorded positions for.
   */
  attributeRanges?: Readonly<Record<string, SourceSpan>>;
  /**
   * What a rendering engine resolved for this node, when an adapter was asked to read it.
   *
   * Absent everywhere else, including on every static input — there is no layout to read in a file.
   * A rule that reads this must declare `computed-style` or `viewport`, and will be skipped where
   * they are unavailable rather than seeing an absent value it could mistake for a default.
   */
  visual?: VisualFacts;
  /**
   * What a live form knows about this control, when an adapter was asked to read it.
   *
   * Present only on form controls, and only on a runtime with constraint validation. A rule that
   * reads this must declare `form`.
   */
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

import type { AiAugmentation } from "./ai-augmentation.js";
import type { DocumentComment } from "./suppression-directive.js";

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
    /** Set by the DOM adapter when an open shadow root was inlined (informational). */
    containsShadow?: boolean;
    /**
     * Lowercase hex SHA-256 of the source this document was parsed from.
     *
     * Supplied by whoever read the input, because hashing is I/O-adjacent and this package is
     * browser-safe. A rule proposing a remediation copies it into `Remediation.fileChecksum`, which
     * is what lets applying refuse a file that changed since the scan.
     */
    sourceChecksum?: string;
  };
  /** A page can legitimately be several contexts at once (e.g. pricing + subscription). */
  pageContexts: readonly PageContextSignal[];
  /**
   * Comments the adapter found, with their line numbers.
   *
   * Only the adapters whose input has both — static HTML and JSX/TSX. A live DOM has comments but no
   * stable lines, and a Figma document has neither; both leave this absent rather than supplying
   * something that looks usable and is not.
   */
  comments?: readonly DocumentComment[];
  /**
   * What this document can answer for, when it differs from its runtime's baseline.
   *
   * Absent means the baseline in `RUNTIME_CAPABILITIES` — what this repository's own adapter for the
   * runtime supplies. An adapter that reads more than the baseline (a live DOM that also resolved
   * computed style) or less (a partial tree) states its own set here. An empty array is a claim, not
   * a gap: it says this document backs nothing, and every rule is skipped for it.
   */
  capabilities?: readonly CapabilityId[];
}

export interface Evidence {
  locator?: NodeLocator;
  text?: string;
  snippet?: string;
  source?: SourceLocation;
  /**
   * The journey step this evidence came from.
   *
   * Present only on findings from a journey scan, where a locator alone is ambiguous — the same
   * selector exists on every step. A reporter that needs a file for such a finding resolves it
   * through the step, the way a locator-only SARIF result is anchored to the file that was scanned.
   */
  stepId?: string;
}

export interface Finding {
  /** Unique within a single report (run-scoped). */
  id: string;
  /** Stable across runs for the same underlying issue — used for CI baselines. */
  fingerprint: string;
  /** Batch-specific occurrence identifier to prevent cross-file collisions (optional). */
  batchOccurrenceId?: string;
  ruleId: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  title: string;
  description: string;
  /** One finding may rest on several pieces of evidence (e.g. "accept present" + "reject missing"). */
  evidence: Evidence[];
  whyItMatters: string;
  recommendation: string;
  references?: readonly string[];
  /**
   * A proposed edit, when the rule could produce one.
   *
   * Absent on most findings, and its absence is not a defect: `recommendation` says what to do in
   * prose, and only some problems have a mechanical fix. Nothing applies this yet.
   */
  remediation?: Remediation;
}

/** Why a rule the scan knew about did not run. */
export type RuleSkipReason =
  /** The effective configuration did not enable it. */
  | "not-enabled"
  /** The input cannot supply something the rule requires. */
  | "missing-capability"
  /** The rule is scoped to page contexts this document does not match. */
  | "page-context-mismatch";

/** What one rule did on one scan. */
export interface RuleCoverage {
  readonly ruleId: string;
  readonly executed: boolean;
  /** Present exactly when `executed` is false. */
  readonly skipReason?: RuleSkipReason;
  /** The required capabilities this input could not supply. Present only with `missing-capability`. */
  readonly missingCapabilities?: readonly CapabilityId[];
  /**
   * Optional capabilities the rule ran without.
   *
   * The rule produced results, and with less than the evidence it can use — a weaker pass than one
   * with everything available, and reported as such rather than as a clean one.
   */
  readonly missingOptionalCapabilities?: readonly CapabilityId[];
}

export interface ScanCapabilityCoverage {
  readonly available: readonly CapabilityId[];
  /**
   * Capabilities this scan did not have: the built-in vocabulary plus anything the rule set asked
   * for, minus what was available. Bounded on purpose — an unbounded list of ids nobody named would
   * describe nothing.
   */
  readonly unavailable: readonly CapabilityId[];
}

export interface ScanCoverageSummary {
  /** Every rule in the composed set, enabled or not. */
  readonly total: number;
  /** Rules the effective configuration enabled. `total - eligible` were not enabled. */
  readonly eligible: number;
  /** Eligible rules that ran. */
  readonly executed: number;
  /** Eligible rules that did not run; each one's reason is in `rules`. */
  readonly skipped: number;
}

/**
 * What this scan was able to check — reported beside what it found, never instead of it.
 *
 * This is a description, not a score. It does not say the executed rules were right, that the
 * available capabilities were enough, or that an empty findings list means a page is fair. It says
 * which rules ran, which did not, and why.
 */
export interface ScanCoverage {
  readonly capabilities: ScanCapabilityCoverage;
  readonly summary: ScanCoverageSummary;
  /** Every rule in the composed set, in the order the scan considered them. */
  readonly rules: readonly RuleCoverage[];
}

// ── Remediation ─────────────────────────────────────────────────────────────

/**
 * Whether applying this edit needs a human first.
 *
 * The distinction is the whole point of the schema. Removing a `checked` attribute is not the same
 * kind of act as rewriting a sentence a user will read, and deciding which is which at apply time —
 * by whoever happens to be running the command — is how the second one gets applied by accident.
 */
export type RemediationSafety =
  /** Mechanical, local, and reversible by reading the diff. Eligible for automatic application. */
  | "safe"
  /** Correct only if a human agrees with it. Never applied automatically, whatever flag is passed. */
  | "review-required";

/**
 * Where the proposed edit came from.
 *
 * Present so that "AI-generated edits are never auto-applied" is a validation rule rather than a
 * promise in a document. An `ai` remediation cannot be `safe`; the gate exists before the thing it
 * gates, because a boundary added after the feature is a boundary someone has already worked around.
 */
export type RemediationOrigin =
  /** Produced deterministically by a rule in a RulePack. */
  | "rule"
  /** Suggested by an AI provider. Never `safe`, whatever it claims. */
  | "ai";

/**
 * One replacement in one file.
 *
 * `expected` is what the range must currently contain. A range on its own is a bet that nothing
 * moved between the scan and the write, and that bet is lost quietly: the edit lands somewhere
 * plausible and the file is wrong in a way no error reports.
 */
export interface TextEdit {
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  /** The exact text the range holds now. Applying refuses when it does not match. */
  readonly expected: string;
  readonly replacement: string;
}

/**
 * A proposed fix for one finding, in one file.
 *
 * One file on purpose. A remediation spanning several is a different problem — partial application,
 * ordering, and rollback all arrive with it — and pretending otherwise in the schema would make the
 * hard case look supported.
 */
export interface Remediation {
  readonly id: string;
  readonly origin: RemediationOrigin;
  readonly safety: RemediationSafety;
  readonly title: string;
  /** What it changes, in a sentence a reviewer can check against the diff. */
  readonly description: string;
  /**
   * Why it is safe, or why it is not.
   *
   * Required for both. A `safe` classification needs an argument more than a cautious one does, and
   * a remediation whose author could not write the sentence should not be carrying the label.
   */
  readonly rationale: string;
  /** The file the edits apply to, as the report names it. */
  readonly file: string;
  /** SHA-256 of the file contents the edits were computed against, lowercase hex. */
  readonly fileChecksum: string;
  readonly edits: ReadonlyNonEmptyArray<TextEdit>;
}

/**
 * Which input a report describes.
 *
 * One declaration for the single report's `input`, the batch's `inputs[]`, and each batch
 * sub-report's `input`. They were three literals saying almost the same thing, and "almost" is how a
 * batch came to carry `figmaFile` while a single report could not.
 */
export interface FairUxReportInput {
  file?: string;
  runtime: Runtime;
  /**
   * The Figma REST file name, when the runtime is `figma`.
   *
   * A `.figjson` path is whatever somebody named the export; this is what the file is called in
   * Figma, which is the only name a designer would recognise. Absent for every other runtime.
   */
  figmaFile?: string;
}

/**
 * Everything a report says about one scanned input.
 *
 * This is the shape, and the *only* shape, a per-input report has. A batch entry is this; a single
 * report is this plus the envelope fields that describe the run rather than the input.
 *
 * Written as one type because it was previously written twice — once as `FairUxReport` and once as
 * an inline literal inside `FairUxBatchReport.reports[]` — and the second copy was a shrinking
 * subset of the first. Every field that appeared on one and not the other was a fact a directory
 * scan lost and a single-file scan kept.
 */
export interface FairUxInputReport {
  input: FairUxReportInput;
  summary: { total: number; bySeverity: Record<Severity, number> };
  /**
   * What the scan was able to check.
   *
   * Per input, never rolled up: two inputs in one batch can have different capabilities. Optional in
   * the type because a report built before it existed is still valid, and because a consumer must
   * tolerate its absence rather than read a missing block as full coverage.
   */
  coverage?: ScanCoverage;
  findings: Finding[];
  /**
   * Findings an inline `fairux-disable-next-line` comment accepted, with the reason given.
   *
   * Additive and always present when a directive applied, never when none did. Recorded rather than
   * dropped: a suppression nobody can see is a rule that was silently turned off, and the argument
   * is the only thing distinguishing the two.
   */
  suppressed?: readonly AppliedSuppression[];
  /**
   * Directives that named themselves and could not be used, or matched nothing.
   *
   * A malformed directive that suppressed nothing silently would leave a user believing a finding
   * was accepted when it was not — the worse of the two failures.
   */
  suppressionDiagnostics?: readonly SuppressionDiagnostic[];
  /**
   * Advisory AI output, when a provider was configured and answered.
   *
   * Its own field, never merged into `findings`. Everything downstream — baselines, fingerprints,
   * SARIF results, `--fail-on` — is built on findings being deterministic and reproducible, and an
   * AI observation is neither. A consumer that wants it asks for it here.
   */
  aiAugmentation?: AiAugmentation;
}

/**
 * JSON output envelope. This is treated as a PUBLIC API from v0 — additive changes only,
 * and `schemaVersion` bumps for anything breaking.
 */
export interface FairUxReport extends FairUxInputReport {
  kind: "single";
  schemaVersion: "0.1";
  toolVersion: string;
  generatedAt: string;
  /** Rule-pack provenance. Omitted for legacy `scan()` calls without pack context. */
  rulePacks?: readonly RulePackReference[];
  /**
   * What a `--suppress` or `--baseline` file removed from this report, in the order the files ran.
   *
   * `findings` is what a run *reported*. Without this, nothing in the artifact says it is not also
   * what the run *detected*. A pipeline that uploads the JSON and a reviewer who opens it six months
   * later both see a shorter list and no way to learn that a file made it shorter — the accounting
   * existed, and went to stderr, which is the one place a stored artifact does not keep.
   *
   * Present exactly when a filter file was applied, and absent otherwise: a report with no
   * `externalFilters` had none, which is a claim this field is now able to make.
   */
  externalFilters?: readonly ExternalFilterRecord[];
}

/**
 * One external filter file, and everything it did.
 *
 * Both filters are file-driven and both subtract, so both are recorded the same way and a reader
 * does not need to know which is which to read the accounting. `kind` says which is which anyway,
 * because the two mean different things: a suppression carries an argument and may expire, a
 * baseline says only "accepted, as of a date".
 */
export interface ExternalFilterRecord {
  readonly kind: "suppressions" | "baseline";
  /** The path as it was given on the command line. */
  readonly file: string;
  /**
   * `sha256:<hex>` over the file's bytes.
   *
   * The path says which file was named; this says which version of it ran. A baseline that grew
   * three entries between two runs is the ordinary way a report gets quietly shorter, and the path
   * is identical across that change.
   */
  readonly digest: string;
  /** What the file says about itself. A baseline records these; a suppressions file does not. */
  readonly identity?: {
    readonly schemaVersion: string;
    readonly toolVersion?: string;
    readonly createdAt?: string;
  };
  /** The count this filter was handed. For the first filter applied, what the scan detected. */
  readonly detected: { readonly total: number; readonly bySeverity: Record<Severity, number> };
  /** The count this filter left. For the last filter applied, the report's own summary. */
  readonly reported: { readonly total: number; readonly bySeverity: Record<Severity, number> };
  /** Entries that removed at least one finding, with how many each removed. */
  readonly applied: readonly ExternalFilterEntry[];
  /**
   * Suppressions past their `expiresOn`, which therefore removed nothing.
   *
   * Not the same as unmatched, and kept separate for that reason: an expired entry matched nothing
   * because it stopped applying, and its findings are in `findings` above.
   */
  readonly expired?: readonly ExternalFilterEntry[];
  /** Entries naming a finding this scan did not produce — a filter nobody will otherwise remove. */
  readonly unmatched?: readonly ExternalFilterEntry[];
  /** Baseline entries whose findings are absent, so the file can shrink. */
  readonly resolved?: readonly ExternalFilterEntry[];
}

/** One entry of a filter file, as the report records it. */
export interface ExternalFilterEntry {
  readonly fingerprint: string;
  readonly ruleId?: string;
  /** Required of a suppression, absent from a baseline, which has no place to put one. */
  readonly reason?: string;
  readonly expiresOn?: string;
  /** How many findings this entry removed. Present only on `applied`, where it is at least 1. */
  readonly count?: number;
}

/** One inline suppression that applied. */
export interface AppliedSuppression {
  readonly ruleId: string;
  readonly reason: string;
  /** 1-based line the directive comment sits on; it applies to the line after. */
  readonly line: number;
  /**
   * `fingerprints.fairuxV1` of the finding this directive removed.
   *
   * The rule and the line say which directive fired; only this says *which finding*. Two identical
   * inputs on one line are two findings of one rule, and a reader deciding whether the right one
   * was accepted has nothing else to match on.
   *
   * It is also what stops a baseline calling a finding resolved when it is merely hidden. A finding
   * an inline directive removed never reaches `findings`, so `--baseline` saw its entry matching
   * nothing and reported it as safe to delete — deleting the record of an accepted risk because a
   * *different* mechanism was also hiding it.
   *
   * Optional because a caller may apply directives to something that is not a `Finding`; every
   * report this project produces carries it.
   */
  readonly fingerprint?: string;
}

/** An inline directive that did not do what its author intended. */
export interface SuppressionDiagnostic {
  readonly line: number;
  readonly kind: "malformed" | "unused";
  readonly message: string;
}

/**
 * Batch report envelope for multi-file scans (directory, glob).
 * Each file gets its own FairUxReport with correct runtime and file path.
 * The aggregate summary rolls up all findings across files.
 * Finding IDs are namespaced as `<fileIndex>:<findingId>` to stay unique.
 */
export interface FairUxBatchReport {
  kind: "batch";
  schemaVersion: "0.1";
  toolVersion: string;
  generatedAt: string;
  /** One per scanned input, in the same order as `reports`, and the same shape each report carries. */
  inputs: FairUxReportInput[];
  /** Rule-pack provenance. Omitted for legacy batch reports without pack context. */
  rulePacks?: readonly RulePackReference[];
  summary: {
    total: number;
    bySeverity: Record<Severity, number>;
    byRuntime?: Record<Runtime, { total: number; bySeverity: Record<Severity, number> }>;
  };
  /**
   * One per input, and structurally the same contract a single report carries.
   *
   * `FairUxInputReport`, not a literal that repeats most of it. The literal it replaces had been a
   * shrinking subset for a release: it named `input`, `summary`, `coverage`, and `findings`, so
   * scanning one file reported that an inline directive had turned a rule off and scanning the
   * directory containing it did not. Sharing the declaration is what makes that class of divergence
   * impossible rather than merely fixed once.
   */
  reports: FairUxInputReport[];
  /**
   * What a `--suppress` or `--baseline` file removed, in the order the files ran.
   *
   * Batch-level and not per-input, because a filter file is applied to the run rather than to a
   * file: an entry names a fingerprint, and which input produced it is a fact about the scan.
   * `detected` and `reported` are therefore whole-run counts, which is the pair a reader needs to
   * see that the two differ at all. See {@link FairUxReport.externalFilters}.
   */
  externalFilters?: readonly ExternalFilterRecord[];
}

// ── Journeys ────────────────────────────────────────────────────────────────

/**
 * How the user got from the previous step to this one.
 *
 * Deliberately coarse. A selector, a wait condition, or a browser instruction is a property of
 * whatever drove the flow, and putting one here would make this contract depend on a driver that
 * does not exist.
 */
export interface JourneyTransition {
  readonly kind: "navigation" | "in-page" | "unknown";
  readonly note?: string;
}

/** One step of a journey: a document the caller already has, and where it sits in the flow. */
export interface JourneyStep {
  /** Stable across runs, and unique within the journey. Baselines and diffs key on it. */
  readonly id: string;
  /** Explicit rather than positional, so a reordered array cannot silently change the flow. */
  readonly order: number;
  readonly document: UiDocument;
  readonly url?: string;
  /** Where this step is, when it has no URL — a screen name, a route, a Figma frame. */
  readonly location?: string;
  /** What the user did to reach the next step ("Continue", "Cancel subscription"). */
  readonly actionLabel?: string;
  readonly transition?: JourneyTransition;
}

export interface JourneyInput {
  readonly steps: readonly JourneyStep[];
}

/** One step as a journey rule sees it. */
export interface JourneyStepView {
  readonly id: string;
  readonly order: number;
  readonly doc: UiDocument;
  readonly url?: string;
  readonly location?: string;
  readonly actionLabel?: string;
  readonly transition?: JourneyTransition;
}

/** The whole flow, in order. */
export interface JourneyView {
  readonly steps: readonly JourneyStepView[];
}

export interface CreateJourneyFindingInput extends CreateFindingInput {
  /**
   * The step this finding is anchored to.
   *
   * Required, because a journey finding without one cannot be placed: the same locator exists on
   * every step, and a reader cannot act on "somewhere in this flow".
   */
  readonly stepId: string;
}

export interface JourneyRuleContext {
  readonly journey: JourneyView;
  readonly locale: Locale;
  readonly text: TextMatcher;
  getDictionary(): PatternGroup;
  createFinding(input: CreateJourneyFindingInput): Finding;
}

/**
 * A rule that reads the whole flow.
 *
 * Its `requiredCapabilities` must include `journey`, which is the point: a rule that only needs one
 * document is an ordinary `Rule`, and running it once per step is what the step reports already do.
 */
export interface JourneyRule {
  readonly meta: RuleMeta;
  readonly evaluate: (journey: JourneyView, ctx: JourneyRuleContext) => Finding[];
}

export interface JourneyStepReport {
  readonly id: string;
  readonly order: number;
  readonly url?: string;
  readonly location?: string;
  /** Exactly what `scan()` produces for that document, unchanged. */
  readonly report: FairUxReport;
}

/**
 * A journey's output: every step's own report, plus the findings that exist only across steps.
 *
 * The two layers are disjoint by construction. A journey rule that re-reported a single step's
 * problem would make one issue read as two, which is the failure this split exists to prevent.
 */
export interface JourneyReport {
  kind: "journey";
  schemaVersion: "0.1";
  toolVersion: string;
  generatedAt: string;
  /** In `order`, always — not in the order the caller happened to pass them. */
  steps: readonly JourneyStepReport[];
  /** Cross-step findings only. */
  findings: readonly Finding[];
  /** Counts `findings`. */
  summary: { total: number; bySeverity: Record<Severity, number> };
  /** Rolled up from the steps. Disjoint from `summary`, so the two may be added. */
  stepSummary: { total: number; bySeverity: Record<Severity, number> };
  /** What the journey rules could check. Each step's own coverage stays on its report. */
  coverage?: ScanCoverage;
  rulePacks?: readonly RulePackReference[];
}

// ── Rules ──────────────────────────────────────────────────────────────────

export interface RuleMeta {
  readonly id: string;
  readonly title: string;
  readonly category: Category;
  readonly defaultSeverity: Severity;
  readonly defaultConfidence: Confidence;
  /** Non-experimental rules run by default; experimental ones only when explicitly enabled. */
  readonly defaultEnabled: boolean;
  readonly experimental?: boolean;
  /** If set, the rule only runs when the document matches one of these page contexts. */
  readonly appliesTo?: readonly PageContext[];
  /** Minimum confidence of a matching page-context signal required to run (default "low"). */
  readonly appliesToMinConfidence?: Confidence;
  readonly tags: readonly string[];
  /** semver-like, e.g. "1.0.0". The major is folded into finding fingerprints. */
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

export interface RulePackReference {
  readonly id: string;
  readonly version: string;
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
  /**
   * Rules that read the whole flow rather than one document.
   *
   * Absent in every pack that has none, rather than empty. Their ids share one namespace with
   * `rules`: a journey rule and a document rule cannot both be called the same thing.
   */
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

// ── Rule context (split by responsibility to avoid a god object) ─────────────

/** A localized group of named pattern lists, e.g. `{ freeTrial: [...], renewal: [...] }`. */
export type PatternGroup = Readonly<Record<string, readonly RegExp[]>>;
export type KeywordDictionary = Readonly<Partial<Record<Locale, PatternGroup>>>;

export interface NodeQueries {
  ancestors(node: UiNode): UiNode[];
  descendants(node: UiNode): UiNode[];
  closest(node: UiNode, predicate: (n: UiNode) => boolean): UiNode | undefined;
  /** Heuristic "text near this node": normalizedText of the ancestor `levels` up (default 1). */
  nearbyText(node: UiNode, levels?: number): string;
}

export interface UiSemantics {
  isButtonLike(node: UiNode): boolean;
  isLinkLike(node: UiNode): boolean;
  isInput(node: UiNode): boolean;
  /** Best-effort human label for a control (accessible name, own text, associated <label>, value). */
  getControlLabel(node: UiNode): string;
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
  /** Override the text fed into the fingerprint's stable hint (defaults to first evidence text). */
  fingerprintText?: string;
  /** A proposed edit. Validated like evidence is — a malformed one is refused, not dropped. */
  remediation?: Remediation;
}

export interface RuleContext {
  readonly doc: UiDocument;
  readonly locale: Locale;
  readonly queries: NodeQueries;
  readonly semantics: UiSemantics;
  readonly text: TextMatcher;
  /** Patterns merged across all configured locales (en+ja), so matching is language-agnostic. */
  getDictionary(): PatternGroup;
  getPageContexts(): readonly PageContextSignal[];
  createFinding(input: CreateFindingInput): Finding;
}

export interface ScanOptions {
  locale?: Locale;
  dictionary?: KeywordDictionary;
  /** Run experimental rules too (default false). */
  includeExperimental?: boolean;
  /**
   * Per-rule overrides keyed by ruleId. `false` disables a rule outright; an object can
   * disable/enable and/or change severity. `{ enabled: true }` force-enables a rule even when
   * experimental (it bypasses the `includeExperimental` gate for that one rule). Confidence is
   * intentionally NOT overridable — it expresses detection certainty, not team policy.
   */
  ruleOverrides?: Readonly<Record<string, boolean | RuleOverride>>;
  /** Recorded into the report envelope. */
  toolVersion?: string;
  /** Additive provenance metadata recorded into the report envelope. */
  rulePacks?: readonly RulePackReference[];
  /** Injectable clock for deterministic output in tests. */
  now?: () => Date;
}

/** Per-rule override applied by `scan()` (see `ScanOptions.ruleOverrides`). */
export interface RuleOverride {
  readonly enabled?: boolean;
  readonly severity?: Severity;
}

/**
 * User-supplied configuration shape (loaded from `fairux.config.{ts,mjs,js,json}` by the CLI).
 * The type lives in `@fairux/core` so it is browser-safe; discovery and loading are Node-side
 * concerns and live in `@fairux/config-node` and the CLI.
 */
export interface FairuxConfig {
  /** Forward-compat marker; current shape is version 1. */
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
  /**
   * Scan a flow. Separate from `scan` on purpose: one API that took either a document or several
   * would complicate the input, the output, and every surface that renders them.
   */
  readonly scanJourney: (input: JourneyInput) => JourneyReport;
}
