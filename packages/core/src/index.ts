// Public API of @fairux/core. Everything a rule author or an adapter needs, and nothing
// runtime-specific (no Node, no DOM, no parser types) — that's the whole point.

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
  InputTooLargeError,
  MAX_INPUT_BYTES,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
} from "./limits.js";
export { isLocaleTag } from "./locale.js";
export { detectPageContexts } from "./page-context.js";
export { createNodeQueries } from "./queries.js";
export {
  type ComposeRulePacksOptions,
  composeRulePacks,
  createScanner,
} from "./rule-pack.js";
export { RulePackError } from "./rule-pack-error.js";
export { scan } from "./scan.js";
export { normalizeScannerPolicy, ScannerPolicyError } from "./scanner-policy.js";
export { buildSelector } from "./selector.js";
export { createUiSemantics } from "./semantics.js";
export { normalizeText } from "./text.js";
export type * from "./types.js";
export { utf8ByteLength } from "./utf8.js";
