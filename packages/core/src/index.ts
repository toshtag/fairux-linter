// Public API of @fairux/core. Everything a rule author or an adapter needs, and nothing
// runtime-specific (no Node, no DOM, no parser types) — that's the whole point.

export {
  type AiAugmentation,
  type AiAugmentationOptions,
  type AiFailure,
  type AiFailureCode,
  type AiObservation,
  type AiPayload,
  type AiProvenance,
  type AiProvider,
  buildAiPayload,
  findingSeverities,
  runAiAugmentation,
} from "./ai-augmentation.js";
export {
  type ApplyRemediationOptions,
  applyRemediations,
  type RemediationApplication,
  type RemediationRefusal,
  type RemediationRefusalCode,
} from "./apply-remediation.js";
export {
  BUILTIN_CAPABILITIES,
  BUILTIN_CAPABILITY_IDS,
  type CapabilityDefinition,
  isBuiltinCapabilityId,
  missingCapabilities,
  RUNTIME_CAPABILITIES,
  resolveDocumentCapabilities,
  sortCapabilityIds,
} from "./capability.js";
export {
  createRuleContext,
  createTextMatcher,
  type RuleContextDeps,
} from "./context.js";
export { type CreateUiDocumentArgs, createUiDocument } from "./document.js";
export {
  buildFingerprint,
  deriveTextHint,
  type FingerprintParts,
  fnv1a64,
  majorVersion,
} from "./fingerprint.js";
export {
  JourneyInputError,
  type ScanJourneyOptions,
  scanJourney,
} from "./journey.js";
export { isBuiltinJurisdictionId } from "./jurisdiction.js";
export {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
} from "./limits.js";
export { isLocaleTag } from "./locale.js";
export { detectPageContexts, PAGE_CONTEXT_KEYWORDS } from "./page-context.js";
export { createNodeQueries } from "./queries.js";
export {
  type ComputeRiskIndexOptions,
  type ContributingFinding,
  computeRiskIndex,
  RISK_INDEX_SCHEMA_VERSION,
  type RiskIndexCoverage,
  RiskIndexError,
  type RiskIndexInput,
  type RiskIndexModel,
  type RiskIndexModelInput,
  type RiskIndexModelResult,
  type RiskIndexReason,
  type RiskIndexReasonCode,
  type RiskIndexReport,
  type RiskIndexStatus,
  type RiskIndexVersions,
  riskIndexStandingLimitations,
} from "./risk-index.js";
export {
  type ComposeRulePacksOptions,
  composeRulePacks,
  createScanner,
} from "./rule-pack.js";
export { RulePackError } from "./rule-pack-error.js";
export type { ResolvedRuleActivation, RuleActivationReason } from "./scan.js";
export { resolveRuleActivations, scan } from "./scan.js";
export { normalizeScannerPolicy, ScannerPolicyError } from "./scanner-policy.js";
export {
  buildSelector,
  joinCssLocator,
  SHADOW_LOCATOR_SEPARATOR,
  splitCssLocator,
} from "./selector.js";
export { createUiSemantics } from "./semantics.js";
export { compareSemver, isSemver } from "./semver.js";
export { removeAttributeEdit } from "./source-range.js";
export type {
  DocumentComment,
  MalformedDirective,
  ParsedDirectives,
  SuppressionDirective,
} from "./suppression-directive.js";
export {
  applySuppressionDirectives,
  findingSourceLine,
  parseSuppressionDirectives,
  SUPPRESSION_DIRECTIVE,
} from "./suppression-directive.js";
export { normalizeText } from "./text.js";
export type * from "./types.js";
export { utf8ByteLength } from "./utf8.js";
