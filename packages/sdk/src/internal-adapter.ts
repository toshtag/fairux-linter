import {
  MAX_INPUT_BYTES as CORE_MAX_INPUT_BYTES,
  MAX_NODE_COUNT as CORE_MAX_NODE_COUNT,
  MAX_TREE_DEPTH as CORE_MAX_TREE_DEPTH,
  InputTooLargeError as CoreInputTooLargeError,
  RiskIndexError as CoreRiskIndexError,
  RulePackError as CoreRulePackError,
  ScannerPolicyError as CoreScannerPolicyError,
  composeRulePacks as composeCoreRulePacks,
  computeRiskIndex as computeCoreRiskIndex,
  createScanner as createCoreScanner,
} from "@fairux/core";
import { fairuxBuiltinRulePack as coreBuiltinRulePack } from "@fairux/rules";
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
  RiskIndexReport,
  RulePack,
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
export const MAX_NODE_COUNT: number = CORE_MAX_NODE_COUNT;
export const MAX_TREE_DEPTH: number = CORE_MAX_TREE_DEPTH;

export const RiskIndexError: new (message: string) => Error = CoreRiskIndexError;

export const fairuxBuiltinRulePack = coreBuiltinRulePack as unknown as RulePack;

/**
 * Compute a Risk Index for a report.
 *
 * No model ships, so this returns `unsupported` with a reason until one does. That is the accurate
 * answer rather than a degenerate score, and a consumer can already build against the shape.
 */
export function computeRiskIndex(
  report: RiskIndexInput,
  options?: ComputeRiskIndexOptions,
): RiskIndexReport {
  return computeCoreRiskIndex(report as never, options as never) as unknown as RiskIndexReport;
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
