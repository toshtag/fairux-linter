import { ScannerPolicyError } from "./scanner-policy.js";
import type {
  Confidence,
  Evidence,
  NodeLocator,
  PageContext,
  PageContextSignal,
  SourceLocation,
  UiDocument,
} from "./types.js";

const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);
const BUILTIN_PAGE_CONTEXTS = new Set([
  "pricing",
  "checkout",
  "subscription",
  "account-settings",
  "consent",
  "marketing",
  "unknown",
]);
const PAGE_CONTEXT_SIGNAL_KEYS = new Set(["context", "confidence", "evidence"]);
const EVIDENCE_KEYS = new Set(["locator", "text", "snippet", "source"]);
const SOURCE_KEYS = new Set(["file", "startLine", "startColumn"]);
const CSS_LOCATOR_KEYS = new Set(["type", "value"]);
const PATH_LOCATOR_KEYS = new Set(["type", "value"]);
const AST_LOCATOR_KEYS = new Set(["type", "file", "startLine", "startColumn"]);
const FIGMA_LOCATOR_KEYS = new Set(["type", "nodeId"]);
const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface CanonicalizePageContextOptions {
  readonly declaredExternalContexts: ReadonlySet<string>;
}

function compareStableIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function readOwn(record: Record<PropertyKey, unknown>, key: string, field: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  try {
    return record[key];
  } catch {
    throw new ScannerPolicyError(`${field} getter threw while reading the value`, field);
  }
}

function assertDenseArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ScannerPolicyError(`${field} must be an array`, field);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new ScannerPolicyError(`${field}[${index}] must not be sparse`, `${field}[${index}]`);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "length" && !isArrayIndexKey(key, value.length))) {
      throw new ScannerPolicyError(`${field} must not contain custom keys`, field);
    }
  }
  return value;
}

function assertPlainRecord(
  value: unknown,
  field: string,
  allowedKeys: ReadonlySet<string>,
): Record<PropertyKey, unknown> {
  if (!isPlainRecord(value)) {
    throw new ScannerPolicyError(`${field} must be a plain object`, field);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new ScannerPolicyError(`${field} must not contain symbol keys`, field);
    }
    if (!allowedKeys.has(key)) {
      throw new ScannerPolicyError(`Unknown ${field} option "${key}"`, `${field}.${key}`);
    }
  }
  return value;
}

function readOptionalString(
  value: unknown,
  field: string,
  allowUndefined = true,
): string | undefined {
  if (value === undefined && allowUndefined) return undefined;
  if (typeof value === "string") return value;
  throw new ScannerPolicyError(`${field} must be a string`, field);
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ScannerPolicyError(`${field} must be a non-empty string`, field);
}

function readOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new ScannerPolicyError(`${field} must be a finite number`, field);
}

function readRequiredNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new ScannerPolicyError(`${field} must be a finite number`, field);
}

function normalizeSourceLocation(value: unknown, field: string): SourceLocation {
  const record = assertPlainRecord(value, field, SOURCE_KEYS);
  const file = readOptionalString(readOwn(record, "file", `${field}.file`), `${field}.file`);
  const startLine = readOptionalNumber(
    readOwn(record, "startLine", `${field}.startLine`),
    `${field}.startLine`,
  );
  const startColumn = readOptionalNumber(
    readOwn(record, "startColumn", `${field}.startColumn`),
    `${field}.startColumn`,
  );

  return Object.freeze({
    ...(file !== undefined ? { file } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(startColumn !== undefined ? { startColumn } : {}),
  });
}

function normalizeNodeLocator(value: unknown, field: string): NodeLocator {
  if (!isPlainRecord(value)) {
    throw new ScannerPolicyError(`${field} must be a plain object`, field);
  }
  const type = readOwn(value, "type", `${field}.type`);
  if (type === "css") {
    const record = assertPlainRecord(value, field, CSS_LOCATOR_KEYS);
    return Object.freeze({
      type: "css",
      value: readRequiredString(readOwn(record, "value", `${field}.value`), `${field}.value`),
    });
  }
  if (type === "path") {
    const record = assertPlainRecord(value, field, PATH_LOCATOR_KEYS);
    const path = assertDenseArray(readOwn(record, "value", `${field}.value`), `${field}.value`);
    const output: number[] = [];
    for (let index = 0; index < path.length; index += 1) {
      const item = path[index];
      if (!(typeof item === "number" && Number.isInteger(item) && item >= 0)) {
        throw new ScannerPolicyError(
          `${field}.value[${index}] must be a non-negative integer`,
          `${field}.value[${index}]`,
        );
      }
      output.push(item);
    }
    return Object.freeze({ type: "path", value: Object.freeze(output) as unknown as number[] });
  }
  if (type === "ast") {
    const record = assertPlainRecord(value, field, AST_LOCATOR_KEYS);
    return Object.freeze({
      type: "ast",
      file: readRequiredString(readOwn(record, "file", `${field}.file`), `${field}.file`),
      startLine: readRequiredNumber(
        readOwn(record, "startLine", `${field}.startLine`),
        `${field}.startLine`,
      ),
      startColumn: readRequiredNumber(
        readOwn(record, "startColumn", `${field}.startColumn`),
        `${field}.startColumn`,
      ),
    });
  }
  if (type === "figma") {
    const record = assertPlainRecord(value, field, FIGMA_LOCATOR_KEYS);
    return Object.freeze({
      type: "figma",
      nodeId: readRequiredString(readOwn(record, "nodeId", `${field}.nodeId`), `${field}.nodeId`),
    });
  }
  throw new ScannerPolicyError(
    `${field}.type must be one of css, path, ast, figma`,
    `${field}.type`,
  );
}

function normalizeEvidence(value: unknown, field: string): Evidence {
  const record = assertPlainRecord(value, field, EVIDENCE_KEYS);
  const locator = readOwn(record, "locator", `${field}.locator`);
  const text = readOptionalString(readOwn(record, "text", `${field}.text`), `${field}.text`);
  const snippet = readOptionalString(
    readOwn(record, "snippet", `${field}.snippet`),
    `${field}.snippet`,
  );
  const source = readOwn(record, "source", `${field}.source`);

  return Object.freeze({
    ...(locator !== undefined
      ? { locator: normalizeNodeLocator(locator, `${field}.locator`) }
      : {}),
    ...(text !== undefined ? { text } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(source !== undefined ? { source: normalizeSourceLocation(source, `${field}.source`) } : {}),
  });
}

function normalizeEvidenceArray(value: unknown, field: string): readonly Evidence[] | undefined {
  if (value === undefined) return undefined;
  const array = assertDenseArray(value, field);
  return Object.freeze(array.map((item, index) => normalizeEvidence(item, `${field}[${index}]`)));
}

function isBuiltinPageContext(value: string): boolean {
  return BUILTIN_PAGE_CONTEXTS.has(value);
}

function normalizePageContextSignal(
  value: unknown,
  field: string,
  declaredExternalContexts: ReadonlySet<string>,
): PageContextSignal {
  const record = assertPlainRecord(value, field, PAGE_CONTEXT_SIGNAL_KEYS);
  const context = readRequiredString(
    readOwn(record, "context", `${field}.context`),
    `${field}.context`,
  );
  if (!isBuiltinPageContext(context) && !declaredExternalContexts.has(context)) {
    throw new ScannerPolicyError(
      `${field}.context must be declared by a configured RulePack taxonomy`,
      `${field}.context`,
    );
  }
  const confidence = readOwn(record, "confidence", `${field}.confidence`);
  if (!(typeof confidence === "string" && VALID_CONFIDENCE.has(confidence))) {
    throw new ScannerPolicyError(
      `${field}.confidence must be one of low, medium, high`,
      `${field}.confidence`,
    );
  }
  const evidence = normalizeEvidenceArray(
    readOwn(record, "evidence", `${field}.evidence`),
    `${field}.evidence`,
  );
  return Object.freeze({
    context: context as PageContext,
    confidence: confidence as Confidence,
    ...(evidence !== undefined ? { evidence } : {}),
  });
}

export function canonicalizePageContextSignals(
  value: unknown,
  options: CanonicalizePageContextOptions,
): readonly PageContextSignal[] {
  const array = assertDenseArray(value, "document.pageContexts");
  const byContext = new Map<string, PageContextSignal>();
  for (let index = 0; index < array.length; index += 1) {
    const signal = normalizePageContextSignal(
      array[index],
      `document.pageContexts[${index}]`,
      options.declaredExternalContexts,
    );
    const existing = byContext.get(signal.context);
    if (!existing || CONFIDENCE_RANK[signal.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      byContext.set(signal.context, signal);
    }
  }
  return Object.freeze(
    Array.from(byContext.values()).sort((a, b) => compareStableIds(a.context, b.context)),
  );
}

export function withCanonicalPageContexts(
  document: UiDocument,
  options: CanonicalizePageContextOptions,
): UiDocument {
  const root = document.root;
  const runtime = document.runtime;
  const metadata = document.metadata;
  const all = document.all.bind(document);
  const findAll = document.findAll.bind(document);
  const getNode = document.getNode.bind(document);
  const pageContexts = canonicalizePageContextSignals(document.pageContexts, options);

  return Object.freeze({
    root,
    runtime,
    ...(metadata !== undefined ? { metadata } : {}),
    pageContexts,
    all,
    findAll,
    getNode,
  });
}
