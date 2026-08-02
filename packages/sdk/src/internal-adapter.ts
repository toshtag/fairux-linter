import {
  MAX_INPUT_BYTES as CORE_MAX_INPUT_BYTES,
  MAX_NODE_COUNT as CORE_MAX_NODE_COUNT,
  MAX_TREE_DEPTH as CORE_MAX_TREE_DEPTH,
  PAGE_CONTEXT_KEYWORDS as CORE_PAGE_CONTEXT_KEYWORDS,
  InputTooLargeError as CoreInputTooLargeError,
  RiskIndexError as CoreRiskIndexError,
  RulePackError as CoreRulePackError,
  ScannerPolicyError as CoreScannerPolicyError,
  composeRulePacks as composeCoreRulePacks,
  computeRiskIndex as computeCoreRiskIndex,
  createScanner as createCoreScanner,
  removeAttributeEdit as removeCoreAttributeEdit,
} from "@fairux/core";
import {
  fairuxBuiltinRulePack as coreBuiltinRulePack,
  fairuxRiskIndexModel as coreRiskIndexModel,
  fairuxRiskIndexModelV2 as coreRiskIndexModelV2,
} from "@fairux/rules";
import {
  assertAllowedOptionKeys,
  assertPlainOptionsObject,
  readOwn,
  SCANNER_POLICY_KEYS,
} from "./options.js";
import type {
  ComposedRuleSet,
  ComputeRiskIndexOptions,
  CreateScannerOptions,
  FairuxScanner,
  RiskIndexInput,
  RiskIndexModel,
  RiskIndexReport,
  RulePack,
  TextEdit,
  UiNode,
} from "./public-types.js";
import { FAIRUX_SDK_VERSION } from "./version.js";

type InputTooLargeKind = "bytes" | "nodes" | "depth";
type InputTooLargeErrorInstance = Error & {
  readonly limit: number;
  readonly actual: number;
  readonly kind: InputTooLargeKind;
};
type ScannerPolicyErrorInstance = Error & {
  readonly field?: string;
};

export const RulePackError: new (message: string) => Error = CoreRulePackError;
export const ScannerPolicyError: new (
  message: string,
  field?: string,
) => ScannerPolicyErrorInstance = CoreScannerPolicyError;
export const InputTooLargeError: new (
  limit: number,
  actual: number,
  kind: InputTooLargeKind,
) => InputTooLargeErrorInstance = CoreInputTooLargeError;
export const MAX_INPUT_BYTES: number = CORE_MAX_INPUT_BYTES;

/**
 * The phrases that put a document in each built-in page context.
 *
 * Exported because a pack scoping a rule with `appliesTo` is otherwise guessing what triggers it,
 * and a rule that never runs reports nothing — which reads exactly like a page with nothing wrong.
 */
export const PAGE_CONTEXT_KEYWORDS: Readonly<Record<string, readonly string[]>> =
  CORE_PAGE_CONTEXT_KEYWORDS;
export const MAX_NODE_COUNT: number = CORE_MAX_NODE_COUNT;
export const MAX_TREE_DEPTH: number = CORE_MAX_TREE_DEPTH;

export const RiskIndexError: new (message: string) => Error = CoreRiskIndexError;

export const fairuxBuiltinRulePack = coreBuiltinRulePack as unknown as RulePack;

/** The built-in model, `fairux-risk/1`. Its constants and calibration are documented, not implied. */
export const fairuxRiskIndexModel = coreRiskIndexModel as unknown as RiskIndexModel;

/**
 * `fairux-risk/2` — the same weights, an aggregation that can see breadth.
 *
 * Passed explicitly or not used: `computeRiskIndex` still defaults to `fairux-risk/1`, because two
 * scores are comparable when their `modelVersion` matches and moving the default changes what every
 * number written before it meant.
 */
export const fairuxRiskIndexModelV2 = coreRiskIndexModelV2 as unknown as RiskIndexModel;

/**
 * Compute a Risk Index for a report.
 *
 * Defaults to the built-in model the way scanning defaults to the built-in rule pack — a consumer
 * that wants a different one passes it, and gets refused if it asks for a version that is not there.
 * `@fairux/core` on its own still answers `unsupported`: the engine holds the contract and the model
 * is policy, which is why it ships beside the rules rather than inside the engine.
 */
export function computeRiskIndex(
  report: RiskIndexInput,
  options: ComputeRiskIndexOptions = {},
): RiskIndexReport {
  assertPlainOptionsObject(options);
  const effective: Record<string, unknown> = { ...options };
  effective.model = readOwn(options, "model") ?? fairuxRiskIndexModel;
  return computeCoreRiskIndex(report as never, effective as never) as unknown as RiskIndexReport;
}

/**
 * A `TextEdit` that removes one attribute, built from the node alone.
 *
 * Exported because a pack that runs in a browser extension has no filesystem to fall back on, and
 * a pack that guessed the range would be relying on the applier to catch its arithmetic. Returns
 * `undefined` when the document was not scanned with `sourceRanges`.
 */
export function removeAttributeEdit(node: UiNode, attribute: string): TextEdit | undefined {
  return removeCoreAttributeEdit(node as never, attribute) as TextEdit | undefined;
}

export function composeRulePacks(
  packs: readonly RulePack[],
  options?: { readonly includeExperimental?: boolean },
): ComposedRuleSet {
  return composeCoreRulePacks(packs as never, options) as unknown as ComposedRuleSet;
}

export function createScanner(options: CreateScannerOptions): FairuxScanner {
  assertPlainOptionsObject(options);
  assertAllowedOptionKeys(options, SCANNER_POLICY_KEYS);
  const toolVersion = readOwn(options, "toolVersion");
  const effectiveOptions = {
    rulePacks: readOwn(options, "rulePacks"),
    includeExperimental: readOwn(options, "includeExperimental"),
    ruleOverrides: readOwn(options, "ruleOverrides"),
    severityOverrides: readOwn(options, "severityOverrides"),
    locale: readOwn(options, "locale"),
    toolVersion: toolVersion === undefined ? FAIRUX_SDK_VERSION : toolVersion,
    now: readOwn(options, "now"),
  };
  return createCoreScanner(effectiveOptions as never) as unknown as FairuxScanner;
}
