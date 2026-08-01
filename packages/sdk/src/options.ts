import { ScannerPolicyError } from "@fairux/core";

export const SCANNER_POLICY_KEYS = new Set([
  "rulePacks",
  "includeExperimental",
  "ruleOverrides",
  "severityOverrides",
  "locale",
  "toolVersion",
  "now",
]);

export const HTML_INPUT_OPTION_KEYS = new Set(["file", "pageContexts"]);
export const HTML_JOURNEY_STEP_KEYS = new Set([
  "id",
  "order",
  "html",
  "file",
  "url",
  "location",
  "actionLabel",
  "transition",
  "pageContexts",
]);
export const DOM_INPUT_OPTION_KEYS = new Set([
  "root",
  "url",
  "pageContexts",
  "visualFacts",
  "formFacts",
]);

export function assertPlainOptionsObject(
  options: unknown,
): asserts options is Record<PropertyKey, unknown> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ScannerPolicyError("Scanner options must be a plain object.", "options");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ScannerPolicyError("Scanner options must be a plain object.", "options");
  }
}

export function assertAllowedOptionKeys(
  options: Record<PropertyKey, unknown>,
  allowed: ReadonlySet<string>,
  field = "options",
): void {
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string") {
      throw new ScannerPolicyError(`${field} must not contain symbol keys`, field);
    }
    if (!allowed.has(key)) {
      throw new ScannerPolicyError(`Unknown ${field} option "${key}"`, `${field}.${key}`);
    }
  }
}

export function readOwn(options: Record<PropertyKey, unknown>, key: string): unknown {
  return Object.hasOwn(options, key) ? options[key] : undefined;
}

export function readStringOption(
  options: Record<PropertyKey, unknown>,
  key: string,
): string | undefined {
  const value = readOwn(options, key);
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new ScannerPolicyError(`${key} must be a string`, `options.${key}`);
}

export function readBooleanOption(
  options: Record<PropertyKey, unknown>,
  key: string,
): boolean | undefined {
  const value = readOwn(options, key);
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  // Refused rather than coerced. A truthy string would turn a typo into a page-wide layout read the
  // caller never asked for, and a falsy one would silently drop the capability from the report.
  throw new ScannerPolicyError(`${key} must be a boolean`, `options.${key}`);
}

export function isElementLike(value: unknown): value is Element {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { readonly nodeType?: unknown; readonly tagName?: unknown };
  return candidate.nodeType === 1 && typeof candidate.tagName === "string";
}
