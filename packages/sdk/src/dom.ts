import { parseDocument } from "@fairux/dom";
import { createScanner, fairuxBuiltinRulePack, ScannerPolicyError } from "./index.js";
import {
  assertAllowedOptionKeys,
  assertPlainOptionsObject,
  DOM_INPUT_OPTION_KEYS,
  isElementLike,
  readOwn,
  readStringOption,
  SCANNER_POLICY_KEYS,
} from "./options.js";
import type { FairUxReport, RulePackMeta, ScannerPolicyOptions } from "./public-types.js";

export {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
  ScannerPolicyError,
} from "./index.js";

export interface DomScanInputOptions {
  readonly root?: Element;
  readonly url?: string;
}

export interface ScanDomOptions extends ScannerPolicyOptions, DomScanInputOptions {}

export interface FairuxDomScanner {
  readonly rulePacks: readonly RulePackMeta[];
  readonly scan: (document: Document, options?: DomScanInputOptions) => FairUxReport;
}

const SCAN_DOM_OPTION_KEYS = new Set([...SCANNER_POLICY_KEYS, ...DOM_INPUT_OPTION_KEYS]);

function normalizeScannerPolicyOptions(options: unknown): Record<PropertyKey, unknown> {
  assertPlainOptionsObject(options);
  assertAllowedOptionKeys(options, SCANNER_POLICY_KEYS);
  return options;
}

function readRootOption(options: Record<PropertyKey, unknown>): Element | undefined {
  const root = readOwn(options, "root");
  if (root === undefined) return undefined;
  if (isElementLike(root)) return root;
  throw new ScannerPolicyError("root must be an Element", "options.root");
}

function normalizeDomScanInputOptions(options: unknown): DomScanInputOptions {
  assertPlainOptionsObject(options);
  assertAllowedOptionKeys(options, DOM_INPUT_OPTION_KEYS);
  const root = readRootOption(options);
  const url = readStringOption(options, "url");
  return Object.freeze({
    ...(root !== undefined ? { root } : {}),
    ...(url !== undefined ? { url } : {}),
  });
}

function normalizeScanDomOptions(options: unknown): {
  readonly scannerOptions: Record<PropertyKey, unknown>;
  readonly inputOptions: DomScanInputOptions;
} {
  assertPlainOptionsObject(options);
  assertAllowedOptionKeys(options, SCAN_DOM_OPTION_KEYS);
  const root = readRootOption(options);
  const url = readStringOption(options, "url");
  return Object.freeze({
    scannerOptions: Object.freeze({
      rulePacks: readOwn(options, "rulePacks"),
      includeExperimental: readOwn(options, "includeExperimental"),
      ruleOverrides: readOwn(options, "ruleOverrides"),
      severityOverrides: readOwn(options, "severityOverrides"),
      locale: readOwn(options, "locale"),
      toolVersion: readOwn(options, "toolVersion"),
      now: readOwn(options, "now"),
    }),
    inputOptions: Object.freeze({
      ...(root !== undefined ? { root } : {}),
      ...(url !== undefined ? { url } : {}),
    }),
  });
}

export function createDomScanner(options: ScannerPolicyOptions = {}): FairuxDomScanner {
  const policyOptions = normalizeScannerPolicyOptions(options);
  const rulePacks = readOwn(policyOptions, "rulePacks");
  const scanner = createScanner({
    rulePacks: rulePacks === undefined ? [fairuxBuiltinRulePack] : rulePacks,
    includeExperimental: readOwn(policyOptions, "includeExperimental"),
    ruleOverrides: readOwn(policyOptions, "ruleOverrides"),
    severityOverrides: readOwn(policyOptions, "severityOverrides"),
    locale: readOwn(policyOptions, "locale"),
    toolVersion: readOwn(policyOptions, "toolVersion"),
    now: readOwn(policyOptions, "now"),
  } as never);

  return Object.freeze({
    rulePacks: scanner.rulePacks,
    scan: (document: Document, scanOptions: DomScanInputOptions = {}) => {
      const inputOptions = normalizeDomScanInputOptions(scanOptions);
      const parseOptions = {
        root: inputOptions.root,
        url: inputOptions.url,
      };
      return scanner.scan(parseDocument(document, parseOptions) as never);
    },
  });
}

export function scanDom(document: Document, options: ScanDomOptions = {}): FairUxReport {
  const normalized = normalizeScanDomOptions(options);
  return createDomScanner(normalized.scannerOptions as never).scan(
    document,
    normalized.inputOptions,
  );
}
