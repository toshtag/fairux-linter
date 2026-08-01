import { utf8ByteLength } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import {
  createScanner,
  fairuxBuiltinRulePack,
  InputTooLargeError,
  MAX_INPUT_BYTES,
  ScannerPolicyError,
} from "./index.js";
import {
  assertAllowedOptionKeys,
  assertPlainOptionsObject,
  HTML_INPUT_OPTION_KEYS,
  HTML_JOURNEY_STEP_KEYS,
  readOwn,
  readStringOption,
  SCANNER_POLICY_KEYS,
} from "./options.js";
import {
  mergePageContexts,
  normalizePageContextSignals,
  type PageContextInputSignal,
} from "./page-contexts.js";
import type {
  ComposedTaxonomy,
  FairUxReport,
  JourneyReport,
  JourneyStep,
  JourneyTransition,
  RulePackMeta,
  ScannerPolicyOptions,
} from "./public-types.js";

export {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  MAX_NODE_COUNT,
  MAX_TREE_DEPTH,
  ScannerPolicyError,
} from "./index.js";
export type { PageContextInputSignal } from "./page-contexts.js";

export interface HtmlScanInputOptions {
  readonly file?: string;
  readonly pageContexts?: readonly PageContextInputSignal[];
}

export interface ScanHtmlOptions extends ScannerPolicyOptions, HtmlScanInputOptions {}

/**
 * One step of a journey, as HTML this consumer already has.
 *
 * No selector, no wait condition, no credential: this SDK does not drive a browser, and a contract
 * that accepted driver instructions would imply one exists.
 */
export interface HtmlJourneyStepInput {
  /** Stable across runs, and unique within the journey. */
  readonly id: string;
  /** Explicit, so a reordered array cannot change the flow. */
  readonly order: number;
  readonly html: string;
  readonly file?: string;
  readonly url?: string;
  readonly location?: string;
  readonly actionLabel?: string;
  readonly transition?: JourneyTransition;
  readonly pageContexts?: readonly PageContextInputSignal[];
}

export interface FairuxHtmlScanner {
  readonly rulePacks: readonly RulePackMeta[];
  readonly taxonomy: ComposedTaxonomy;
  readonly scan: (html: string, options?: HtmlScanInputOptions) => FairUxReport;
  /**
   * Scan an ordered flow. Separate from `scan` on purpose: one entry point taking either a page or
   * several would complicate the input, the output, and everything that renders them.
   */
  readonly scanJourney: (steps: readonly HtmlJourneyStepInput[]) => JourneyReport;
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
  const pageContexts = normalizePageContextSignals(readOwn(options, "pageContexts"));
  return Object.freeze({
    ...(file !== undefined ? { file } : {}),
    ...(pageContexts !== undefined ? { pageContexts } : {}),
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
      ...(readOwn(options, "pageContexts") !== undefined
        ? { pageContexts: readOwn(options, "pageContexts") as never }
        : {}),
    }),
  });
}

function normalizeJourneyStep(step: unknown): JourneyStep {
  assertPlainOptionsObject(step);
  assertAllowedOptionKeys(step, HTML_JOURNEY_STEP_KEYS);
  const html = readOwn(step, "html");
  if (typeof html !== "string") {
    throw new ScannerPolicyError("each journey step needs html", "steps[].html");
  }
  const id = readStringOption(step, "id");
  if (id === undefined) {
    throw new ScannerPolicyError("each journey step needs an id", "steps[].id");
  }
  const order = readOwn(step, "order");
  if (!Number.isInteger(order)) {
    throw new ScannerPolicyError("each journey step needs an integer order", "steps[].order");
  }
  assertInputSize(html);

  const file = readStringOption(step, "file");
  const document = parseHtml(html, { file });
  const pageContexts = normalizePageContextSignals(readOwn(step, "pageContexts"));
  const url = readStringOption(step, "url");
  const location = readStringOption(step, "location");
  const actionLabel = readStringOption(step, "actionLabel");
  const transition = readOwn(step, "transition");

  return Object.freeze({
    id,
    order: order as number,
    document: mergePageContexts(document, pageContexts),
    ...(url !== undefined ? { url } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(actionLabel !== undefined ? { actionLabel } : {}),
    ...(transition !== undefined ? { transition: transition as JourneyTransition } : {}),
  }) as JourneyStep;
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
    taxonomy: scanner.taxonomy,
    scan: (html: string, scanOptions: HtmlScanInputOptions = {}) => {
      const inputOptions = normalizeHtmlScanInputOptions(scanOptions);
      assertInputSize(html);
      const document = parseHtml(html, { file: inputOptions.file });
      return scanner.scan(mergePageContexts(document, inputOptions.pageContexts));
    },
    scanJourney: (steps: readonly HtmlJourneyStepInput[]) => {
      if (!Array.isArray(steps)) {
        throw new ScannerPolicyError("journey steps must be an array", "steps");
      }
      // Every step is parsed before any is scanned. A journey that fails halfway would otherwise
      // have already produced reports for the steps before the bad one.
      return scanner.scanJourney({ steps: steps.map(normalizeJourneyStep) });
    },
  });
}

export function scanHtml(html: string, options: ScanHtmlOptions = {}): FairUxReport {
  const normalized = normalizeScanHtmlOptions(options);
  return createHtmlScanner(normalized.scannerOptions as never).scan(html, normalized.inputOptions);
}

/** Scan an ordered flow of HTML pages the caller already has. */
export function scanHtmlJourney(
  steps: readonly HtmlJourneyStepInput[],
  options: ScannerPolicyOptions = {},
): JourneyReport {
  return createHtmlScanner(options).scanJourney(steps);
}
