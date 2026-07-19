/**
 * FairUX Core — type contracts.
 *
 * These types are the boundary every surface (HTML/CLI today; DOM/AST/Figma later) speaks.
 * They are deliberately runtime-agnostic: no DOM, no Node, no parser types leak in here.
 */

export type Runtime = "html" | "dom" | "ast" | "figma";

export type Severity = "info" | "low" | "medium" | "high";
export type Confidence = "low" | "medium" | "high";

export type Category =
  | "consent"
  | "subscription"
  | "cancellation"
  | "scarcity"
  | "hidden-cost"
  | "visual-asymmetry"
  | "privacy"
  | "accessibility"
  | "obstruction";

export type Locale = "en" | "ja";

/** Where a node/finding lives. CSS is just one locator kind, never the center of the model. */
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
 * Best-effort accessible name. NOT a full WAI-ARIA Accessible Name Computation —
 * adapters fill what they cheaply can and record where it came from.
 */
export interface AccessibilityInfo {
  name?: string;
  nameSource?: "aria-label" | "aria-labelledby" | "alt" | "text" | "unknown";
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
}

export type PageContext =
  | "pricing"
  | "checkout"
  | "subscription"
  | "account-settings"
  | "consent"
  | "marketing"
  | "unknown";

export interface PageContextSignal {
  context: PageContext;
  confidence: Confidence;
  evidence?: Evidence[];
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
  };
  /** A page can legitimately be several contexts at once (e.g. pricing + subscription). */
  pageContexts: PageContextSignal[];
}

export interface Evidence {
  locator?: NodeLocator;
  text?: string;
  snippet?: string;
  source?: SourceLocation;
}

export interface Finding {
  /** Unique within a single report (run-scoped). */
  id: string;
  /** Stable across runs for the same underlying issue — used for CI baselines. */
  fingerprint: string;
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
  references?: string[];
}

/**
 * JSON output envelope. This is treated as a PUBLIC API from v0 — additive changes only,
 * and `schemaVersion` bumps for anything breaking.
 */
export interface FairUxReport {
  schemaVersion: "0.1";
  toolVersion: string;
  generatedAt: string;
  input: { file?: string; runtime: Runtime };
  summary: { total: number; bySeverity: Record<Severity, number> };
  findings: Finding[];
}

// ── Rules ──────────────────────────────────────────────────────────────────

export interface RuleMeta {
  id: string;
  title: string;
  category: Category;
  defaultSeverity: Severity;
  defaultConfidence: Confidence;
  /** Non-experimental rules run by default; experimental ones only when explicitly enabled. */
  defaultEnabled: boolean;
  experimental?: boolean;
  /** If set, the rule only runs when the document matches one of these page contexts. */
  appliesTo?: PageContext[];
  /** Minimum confidence of a matching page-context signal required to run (default "low"). */
  appliesToMinConfidence?: Confidence;
  tags: string[];
  /** semver-like, e.g. "1.0.0". The major is folded into finding fingerprints. */
  version: string;
  references?: string[];
}

export interface Rule {
  meta: RuleMeta;
  evaluate(doc: UiDocument, ctx: RuleContext): Finding[];
}

// ── Rule context (split by responsibility to avoid a god object) ─────────────

/** A localized group of named pattern lists, e.g. `{ freeTrial: [...], renewal: [...] }`. */
export type PatternGroup = Readonly<Record<string, readonly RegExp[]>>;
export type KeywordDictionary = Partial<Record<Locale, PatternGroup>>;

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
  ruleOverrides?: Record<string, boolean | RuleOverride>;
  /** Recorded into the report envelope. */
  toolVersion?: string;
  /** Injectable clock for deterministic output in tests. */
  now?: () => Date;
}

/** Per-rule override applied by `scan()` (see `ScanOptions.ruleOverrides`). */
export interface RuleOverride {
  enabled?: boolean;
  severity?: Severity;
}

/**
 * User-supplied configuration shape (loaded from `fairux.config.{ts,mjs,js,json}` by the CLI).
 * The type lives in `@fairux/core` so it is browser-safe; loading is a CLI concern. See ADR P2-T1.
 */
export interface FairuxConfig {
  /** Forward-compat marker; current shape is version 1. */
  configVersion?: 1;
  includeExperimental?: boolean;
  rules?: Record<string, boolean | RuleOverride>;
}
