import { utf8ByteLength } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import {
  createScanner,
  fairuxBuiltinRulePack,
  InputTooLargeError,
  MAX_INPUT_BYTES,
} from "./index.js";
import {
  assertAllowedOptionKeys,
  assertPlainOptionsObject,
  HTML_INPUT_OPTION_KEYS,
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

export interface HtmlScanInputOptions {
  readonly file?: string;
}

export interface ScanHtmlOptions extends ScannerPolicyOptions, HtmlScanInputOptions {}

export interface FairuxHtmlScanner {
  readonly rulePacks: readonly RulePackMeta[];
  readonly scan: (html: string, options?: HtmlScanInputOptions) => FairUxReport;
}

function assertInputSize(html: string): void {
  const byteLength = utf8ByteLength(html);
  if (byteLength > MAX_INPUT_BYTES) {
    throw new InputTooLargeError(MAX_INPUT_BYTES, byteLength, "bytes");
  }
}

const SCAN_HTML_OPTION_KEYS = new Set([...SCANNER_POLICY_KEYS, ...HTML_INPUT_OPTION_KEYS]);

function normalizeScannerPolicyOptions(options: unknown): Record<PropertyKey, unknown> {
  assertPlainOptionsObject(options);
  assertAllowedOptionKeys(options, SCANNER_POLICY_KEYS);
  return options;
}

function normalizeHtmlScanInputOptions(options: unknown): HtmlScanInputOptions {
  assertPlainOptionsObject(options);
  assertAllowedOptionKeys(options, HTML_INPUT_OPTION_KEYS);
  const file = readStringOption(options, "file");
  return Object.freeze({
    ...(file !== undefined ? { file } : {}),
  });
}

function normalizeScanHtmlOptions(options: unknown): {
  readonly scannerOptions: Record<PropertyKey, unknown>;
  readonly inputOptions: HtmlScanInputOptions;
} {
  assertPlainOptionsObject(options);
  assertAllowedOptionKeys(options, SCAN_HTML_OPTION_KEYS);
  const file = readStringOption(options, "file");
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
      ...(file !== undefined ? { file } : {}),
    }),
  });
}

export function createHtmlScanner(options: ScannerPolicyOptions = {}): FairuxHtmlScanner {
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
    scan: (html: string, scanOptions: HtmlScanInputOptions = {}) => {
      const inputOptions = normalizeHtmlScanInputOptions(scanOptions);
      assertInputSize(html);
      return scanner.scan(parseHtml(html, { file: inputOptions.file }));
    },
  });
}

export function scanHtml(html: string, options: ScanHtmlOptions = {}): FairUxReport {
  const normalized = normalizeScanHtmlOptions(options);
  return createHtmlScanner(normalized.scannerOptions as never).scan(html, normalized.inputOptions);
}
