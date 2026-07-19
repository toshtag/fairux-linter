import { isLocaleTag } from "./locale.js";
import { RESERVED_RULE_IDS } from "./rule-id.js";
import type { Locale, RuleOverride, RulePack, ScanOptions, Severity } from "./types.js";

const VALID_SEVERITIES = new Set(["info", "low", "medium", "high"]);
const OVERRIDE_KEYS = new Set(["enabled", "severity"]);
const SCANNER_OPTION_KEYS = new Set([
  "rulePacks",
  "includeExperimental",
  "ruleOverrides",
  "severityOverrides",
  "locale",
  "toolVersion",
  "now",
]);

export class ScannerPolicyError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "ScannerPolicyError";
  }
}

export interface NormalizedScannerPolicy {
  readonly includeExperimental: boolean | undefined;
  readonly ruleOverrides: ScanOptions["ruleOverrides"];
  readonly requestedRuleOverrideIds: readonly string[];
  readonly requestedSeverityOverrideIds: readonly string[];
  readonly locale: Locale | undefined;
  readonly toolVersion: string | undefined;
  readonly now: (() => Date) | undefined;
}

export interface NormalizedCreateScannerOptions {
  readonly rulePacks: readonly RulePack[];
  readonly policy: NormalizedScannerPolicy;
}

function isPlainOptionsObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedOptionKeys(
  value: Record<PropertyKey, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new ScannerPolicyError(`${field} must not contain symbol keys`, field);
    }
    if (!allowed.has(key)) {
      throw new ScannerPolicyError(`Unknown ${field} option "${key}"`, `${field}.${key}`);
    }
  }
}

function readOwn(value: Record<PropertyKey, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function assertSafeRuleId(ruleId: string, field: string): void {
  if (RESERVED_RULE_IDS.has(ruleId)) {
    throw new ScannerPolicyError(`${field} contains reserved rule id "${ruleId}"`, field);
  }
}

function readSeverity(value: unknown, field: string): Severity {
  if (typeof value === "string" && VALID_SEVERITIES.has(value)) return value as Severity;
  throw new ScannerPolicyError(`${field} must be one of info, low, medium, high`, field);
}

function snapshotRuleOverride(value: RuleOverride): Readonly<RuleOverride> {
  return Object.freeze({
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.severity !== undefined ? { severity: value.severity } : {}),
  });
}

function readRuleOverride(value: unknown, field: string): boolean | Readonly<RuleOverride> {
  if (typeof value === "boolean") return value;
  if (!isPlainOptionsObject(value)) {
    throw new ScannerPolicyError(`${field} must be a boolean or rule override object`, field);
  }
  assertAllowedOptionKeys(value, OVERRIDE_KEYS, field);
  const override: { enabled?: boolean; severity?: Severity } = {};
  const enabled = readOwn(value, "enabled");
  const severity = readOwn(value, "severity");
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") {
      throw new ScannerPolicyError(`${field}.enabled must be a boolean`, `${field}.enabled`);
    }
    override.enabled = enabled;
  }
  if (severity !== undefined) {
    override.severity = readSeverity(severity, `${field}.severity`);
  }
  return snapshotRuleOverride(override);
}

function mergeSeverityOverride(
  existing: boolean | Readonly<RuleOverride> | undefined,
  severity: Severity,
): Readonly<RuleOverride> {
  if (typeof existing === "boolean") {
    return Object.freeze({ enabled: existing, severity });
  }
  return snapshotRuleOverride({ ...(existing ?? {}), severity });
}

function readOverrideRecord(
  value: unknown,
  field: "ruleOverrides" | "severityOverrides",
): Record<PropertyKey, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainOptionsObject(value)) {
    throw new ScannerPolicyError(`${field} must be a plain object`, field);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new ScannerPolicyError(`${field} must not contain symbol keys`, field);
    }
  }
  return value;
}

function normalizeRuleOverrides(
  ruleOverrides: unknown,
  severityOverrides: unknown,
): {
  readonly ruleOverrides: ScanOptions["ruleOverrides"];
  readonly requestedRuleOverrideIds: readonly string[];
  readonly requestedSeverityOverrideIds: readonly string[];
} {
  const rawRuleOverrides = readOverrideRecord(ruleOverrides, "ruleOverrides");
  const rawSeverityOverrides = readOverrideRecord(severityOverrides, "severityOverrides");
  if (!rawRuleOverrides && !rawSeverityOverrides) {
    return Object.freeze({
      ruleOverrides: undefined,
      requestedRuleOverrideIds: Object.freeze([]),
      requestedSeverityOverrideIds: Object.freeze([]),
    });
  }

  const merged: Record<string, boolean | Readonly<RuleOverride>> = Object.create(null);
  const requestedRuleOverrideIds: string[] = [];
  const requestedSeverityOverrideIds: string[] = [];
  for (const key of Reflect.ownKeys(rawRuleOverrides ?? {})) {
    const ruleId = key as string;
    assertSafeRuleId(ruleId, "ruleOverrides");
    requestedRuleOverrideIds.push(ruleId);
    merged[ruleId] = readRuleOverride(
      (rawRuleOverrides as Record<PropertyKey, unknown>)[ruleId],
      `ruleOverrides.${ruleId}`,
    );
  }
  for (const key of Reflect.ownKeys(rawSeverityOverrides ?? {})) {
    const ruleId = key as string;
    assertSafeRuleId(ruleId, "severityOverrides");
    requestedSeverityOverrideIds.push(ruleId);
    merged[ruleId] = mergeSeverityOverride(
      Object.hasOwn(merged, ruleId) ? merged[ruleId] : undefined,
      readSeverity(
        (rawSeverityOverrides as Record<PropertyKey, unknown>)[ruleId],
        `severityOverrides.${ruleId}`,
      ),
    );
  }
  return Object.freeze({
    ruleOverrides: Object.freeze(merged),
    requestedRuleOverrideIds: Object.freeze([...requestedRuleOverrideIds]),
    requestedSeverityOverrideIds: Object.freeze([...requestedSeverityOverrideIds]),
  });
}

function normalizeNow(now: unknown): (() => Date) | undefined {
  if (now === undefined) return undefined;
  if (typeof now !== "function") {
    throw new ScannerPolicyError("now must be a function", "now");
  }
  return () => {
    const value = (now as () => unknown)();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ScannerPolicyError("now must return a valid Date", "now");
    }
    return value;
  };
}

export function normalizeCreateScannerOptions(options: unknown): NormalizedCreateScannerOptions {
  if (!isPlainOptionsObject(options)) {
    throw new ScannerPolicyError("Scanner options must be a plain object.", "options");
  }
  assertAllowedOptionKeys(options, SCANNER_OPTION_KEYS, "options");
  const rulePacks = readOwn(options, "rulePacks");
  if (!Array.isArray(rulePacks)) {
    throw new ScannerPolicyError("rulePacks must be an array", "rulePacks");
  }
  const includeExperimental = readOwn(options, "includeExperimental");
  const locale = readOwn(options, "locale");
  const toolVersion = readOwn(options, "toolVersion");
  const now = readOwn(options, "now");

  if (includeExperimental !== undefined && typeof includeExperimental !== "boolean") {
    throw new ScannerPolicyError("includeExperimental must be a boolean", "includeExperimental");
  }

  if (locale !== undefined && !(typeof locale === "string" && isLocaleTag(locale))) {
    throw new ScannerPolicyError("locale must be a well-formed RFC 5646 language tag", "locale");
  }

  if (toolVersion !== undefined) {
    if (
      typeof toolVersion !== "string" ||
      toolVersion.length === 0 ||
      toolVersion.trim() !== toolVersion
    ) {
      throw new ScannerPolicyError("toolVersion must be a non-empty string", "toolVersion");
    }
  }

  const overrides = normalizeRuleOverrides(
    readOwn(options, "ruleOverrides"),
    readOwn(options, "severityOverrides"),
  );

  return Object.freeze({
    rulePacks: Object.freeze([...rulePacks]) as readonly RulePack[],
    policy: Object.freeze({
      includeExperimental: includeExperimental as boolean | undefined,
      ruleOverrides: overrides.ruleOverrides,
      requestedRuleOverrideIds: overrides.requestedRuleOverrideIds,
      requestedSeverityOverrideIds: overrides.requestedSeverityOverrideIds,
      locale: locale as Locale | undefined,
      toolVersion: toolVersion as string | undefined,
      now: normalizeNow(now),
    }),
  });
}

export function normalizeScannerPolicy(options: unknown): NormalizedScannerPolicy {
  return normalizeCreateScannerOptions(options).policy;
}
