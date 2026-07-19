import { ScannerPolicyError } from "@fairux/core";
import type { Confidence, Evidence, PageContext, UiDocument } from "./public-types.js";

export interface PageContextInputSignal {
  readonly context: PageContext;
  readonly confidence: Confidence;
  readonly evidence?: readonly Evidence[];
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
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

export function normalizePageContextSignals(
  value: unknown,
): readonly PageContextInputSignal[] | undefined {
  if (value === undefined) return undefined;
  const array = assertDenseArray(value, "options.pageContexts");
  return Object.freeze([...array]) as readonly PageContextInputSignal[];
}

export function mergePageContexts(
  document: UiDocument,
  pageContexts: readonly PageContextInputSignal[] | undefined,
): UiDocument {
  if (!pageContexts || pageContexts.length === 0) return document;

  return Object.freeze({
    ...document,
    pageContexts: Object.freeze([...document.pageContexts, ...pageContexts]),
  });
}
