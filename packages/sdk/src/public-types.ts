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

export interface AccessibilityInfo {
  name?: string;
  nameSource?: "aria-label" | "aria-labelledby" | "alt" | "text" | "unknown";
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
  };
  pageContexts: readonly PageContextSignal[];
}

export interface Evidence {
  locator?: NodeLocator;
  text?: string;
  snippet?: string;
  source?: SourceLocation;
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
}

export interface RulePackReference {
  readonly id: string;
  readonly version: string;
}

export interface FairUxReport {
  kind: "single";
  schemaVersion: "0.1";
  toolVersion: string;
  generatedAt: string;
  input: { file?: string; runtime: Runtime };
  rulePacks?: readonly RulePackReference[];
  summary: { total: number; bySeverity: Record<Severity, number> };
  findings: Finding[];
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
    findings: Finding[];
  }>;
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
  readonly dictionary?: KeywordDictionary;
}

export interface ComposedRuleSet {
  readonly rules: readonly Rule[];
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
