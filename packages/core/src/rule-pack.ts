import { RESERVED_RULE_IDS } from "./rule-id.js";
import { RulePackError } from "./rule-pack-error.js";
import { scan } from "./scan.js";
import {
  type NormalizedScannerPolicy,
  normalizeCreateScannerOptions,
  ScannerPolicyError,
} from "./scanner-policy.js";
import { createStringRecord, readOwnStringValue } from "./string-record.js";
import type {
  ComposedRuleSet,
  CreateScannerOptions,
  FairUxReport,
  FairuxScanner,
  KeywordDictionary,
  Locale,
  PatternGroup,
  Rule,
  RuleMeta,
  RulePack,
  RulePackMeta,
  RulePackReference,
  UiDocument,
} from "./types.js";

const SUPPORTED_ENGINE_API_VERSION = "1";
const VALID_CATEGORIES = new Set([
  "consent",
  "subscription",
  "cancellation",
  "scarcity",
  "hidden-cost",
  "visual-asymmetry",
  "privacy",
  "accessibility",
  "obstruction",
]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);
const VALID_LOCALES = new Set(["en", "ja"]);
const VALID_SEVERITY = new Set(["info", "low", "medium", "high"]);
const VALID_STATUSES = new Set(["stable", "experimental"]);
const PACK_KEYS = new Set(["meta", "rules", "dictionary"]);
const PACK_META_KEYS = new Set([
  "id",
  "version",
  "engineApiVersion",
  "title",
  "description",
  "status",
]);
const RULE_KEYS = new Set(["meta", "evaluate"]);
const RULE_META_KEYS = new Set([
  "id",
  "title",
  "category",
  "defaultSeverity",
  "defaultConfidence",
  "defaultEnabled",
  "experimental",
  "appliesTo",
  "appliesToMinConfidence",
  "tags",
  "version",
  "references",
]);
const VALID_PAGE_CONTEXTS = new Set([
  "pricing",
  "checkout",
  "subscription",
  "account-settings",
  "consent",
  "marketing",
  "unknown",
]);
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export { RulePackError } from "./rule-pack-error.js";

export interface ComposeRulePacksOptions {
  readonly includeExperimental?: boolean;
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(
  value: unknown,
  field: string,
  allowedKeys: ReadonlySet<string>,
  context: { readonly packId?: string; readonly packVersion?: string },
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    packError("expected a plain object", { ...context, field, value });
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      packError("symbol keys are not supported", { ...context, field, value });
    }
    if (!allowedKeys.has(key)) {
      packError("unknown field", { ...context, field: `${field}.${key}`, value: value[key] });
    }
  }
  return value;
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function packError(
  message: string,
  context: {
    readonly packId?: string;
    readonly packVersion?: string;
    readonly field: string;
    readonly value?: unknown;
  },
): never {
  const pack =
    context.packId || context.packVersion
      ? `Rule pack ${context.packId ?? "<unknown>"}@${context.packVersion ?? "<unknown>"}`
      : "Rule pack";
  const actual = "value" in context ? `; received ${valueKind(context.value)}` : "";
  throw new RulePackError(
    `${pack} has invalid ${context.field}: ${message}; required engine API ${SUPPORTED_ENGINE_API_VERSION}${actual}`,
  );
}

function readNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): string {
  const value = Object.hasOwn(record, field) ? record[field] : undefined;
  if (typeof value === "string" && value.trim().length > 0) return value;
  packError("expected a non-empty string", { ...context, field, value });
}

function readOptionalString(
  record: Record<string, unknown>,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): string | undefined {
  const value = Object.hasOwn(record, field) ? record[field] : undefined;
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  packError("expected a string when present", { ...context, field, value });
}

function readBoolean(
  record: Record<string, unknown>,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): boolean {
  const value = Object.hasOwn(record, field) ? record[field] : undefined;
  if (typeof value === "boolean") return value;
  packError("expected a boolean", { ...context, field, value });
}

function normalizeComposeOptions(options: unknown): Required<ComposeRulePacksOptions> {
  if (options === undefined) return Object.freeze({ includeExperimental: false });
  if (!isPlainRecord(options)) {
    packError("expected a plain object", { field: "options", value: options });
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string") {
      packError("symbol keys are not supported", { field: "options", value: options });
    }
    if (key !== "includeExperimental") {
      packError("unknown option", { field: `options.${key}`, value: options[key] });
    }
  }
  const includeExperimental = options.includeExperimental;
  if (includeExperimental === undefined) return Object.freeze({ includeExperimental: false });
  if (typeof includeExperimental !== "boolean") {
    packError("expected a boolean", {
      field: "options.includeExperimental",
      value: includeExperimental,
    });
  }
  return Object.freeze({ includeExperimental });
}

function validateSemver(
  value: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): void {
  if (SEMVER_RE.test(value)) return;
  packError("expected a semantic version such as 1.0.0 or 0.1.0-beta.1", {
    ...context,
    field,
    value,
  });
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
  context: { readonly packId?: string; readonly packVersion?: string },
): T {
  const value = Object.hasOwn(record, field) ? record[field] : undefined;
  if (typeof value === "string" && allowed.has(value)) return value as T;
  packError(`expected one of ${Array.from(allowed).join(", ")}`, { ...context, field, value });
}

function assertDenseArray(
  value: unknown,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): readonly unknown[] {
  if (!Array.isArray(value)) {
    packError("expected an array", { ...context, field, value });
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      packError("sparse arrays are not supported", {
        ...context,
        field: `${field}[${index}]`,
        value: undefined,
      });
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      packError("symbol array properties are not supported", { ...context, field, value });
    }
    if (key !== "length" && !isArrayIndexKey(key, value.length)) {
      packError("custom array properties are not supported", {
        ...context,
        field: `${field}.${key}`,
        value: value[key as keyof typeof value],
      });
    }
  }
  return value;
}

function cloneStringArray(
  value: unknown,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): string[] {
  const dense = assertDenseArray(value, field, context);
  const output: string[] = [];
  for (let index = 0; index < dense.length; index += 1) {
    const item = dense[index];
    if (typeof item !== "string") {
      packError("expected a string", {
        ...context,
        field: `${field}[${index}]`,
        value: item,
      });
    }
    output.push(item);
  }
  return Object.freeze(output) as unknown as string[];
}

function cloneOptionalStringArray(
  record: Record<string, unknown>,
  property: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): string[] | undefined {
  const value = Object.hasOwn(record, property) ? record[property] : undefined;
  if (value === undefined) return undefined;
  return cloneStringArray(value, field, context);
}

function cloneAppliesTo(
  record: Record<string, unknown>,
  context: { readonly packId?: string; readonly packVersion?: string },
): RuleMeta["appliesTo"] {
  const value = Object.hasOwn(record, "appliesTo") ? record.appliesTo : undefined;
  if (value === undefined) return undefined;
  const dense = assertDenseArray(value, "rule.meta.appliesTo", context);
  const output: Array<NonNullable<RuleMeta["appliesTo"]>[number]> = [];
  for (let index = 0; index < dense.length; index += 1) {
    const item = dense[index];
    if (!(typeof item === "string" && VALID_PAGE_CONTEXTS.has(item))) {
      packError("expected a valid page context", {
        ...context,
        field: `rule.meta.appliesTo[${index}]`,
        value: item,
      });
    }
    output.push(item as NonNullable<RuleMeta["appliesTo"]>[number]);
  }
  return Object.freeze(output) as RuleMeta["appliesTo"];
}

function validatePackMeta(meta: unknown): RulePackMeta {
  const record = assertPlainRecord(meta, "meta", PACK_META_KEYS, {});
  const id = readNonEmptyString(record, "id", {});
  const version = readNonEmptyString(record, "version", { packId: id });
  const context = { packId: id, packVersion: version };
  validateSemver(version, "meta.version", context);
  const engineApiVersion = Object.hasOwn(record, "engineApiVersion")
    ? record.engineApiVersion
    : undefined;
  if (engineApiVersion !== SUPPORTED_ENGINE_API_VERSION) {
    packError(`unsupported engine API ${String(engineApiVersion)}`, {
      ...context,
      field: "meta.engineApiVersion",
      value: engineApiVersion,
    });
  }
  return Object.freeze({
    id,
    version,
    engineApiVersion: SUPPORTED_ENGINE_API_VERSION,
    title: readNonEmptyString(record, "title", context),
    description: readOptionalString(record, "description", context),
    status: readEnum<RulePackMeta["status"]>(record, "status", VALID_STATUSES, context),
  });
}

function cloneRuleMeta(
  meta: unknown,
  context: { readonly packId: string; readonly packVersion: string },
): RuleMeta {
  const record = assertPlainRecord(meta, "rule.meta", RULE_META_KEYS, context);
  const id = readNonEmptyString(record, "id", context);
  if (RESERVED_RULE_IDS.has(id)) {
    packError("reserved rule id", { ...context, field: "rule.meta.id", value: id });
  }
  const version = readNonEmptyString(record, "version", context);
  validateSemver(version, `rule ${id} version`, context);
  return Object.freeze({
    id,
    title: readNonEmptyString(record, "title", context),
    category: readEnum<RuleMeta["category"]>(record, "category", VALID_CATEGORIES, context),
    defaultSeverity: readEnum<RuleMeta["defaultSeverity"]>(
      record,
      "defaultSeverity",
      VALID_SEVERITY,
      context,
    ),
    defaultConfidence: readEnum<RuleMeta["defaultConfidence"]>(
      record,
      "defaultConfidence",
      VALID_CONFIDENCE,
      context,
    ),
    defaultEnabled: readBoolean(record, "defaultEnabled", context),
    experimental:
      (Object.hasOwn(record, "experimental") ? record.experimental : undefined) === undefined
        ? undefined
        : readBoolean(record, "experimental", context),
    appliesTo: cloneAppliesTo(record, context),
    appliesToMinConfidence:
      (Object.hasOwn(record, "appliesToMinConfidence")
        ? record.appliesToMinConfidence
        : undefined) === undefined
        ? undefined
        : readEnum<NonNullable<RuleMeta["appliesToMinConfidence"]>>(
            record,
            "appliesToMinConfidence",
            VALID_CONFIDENCE,
            context,
          ),
    tags: cloneStringArray(record.tags, "rule.meta.tags", context),
    version,
    references: cloneOptionalStringArray(record, "references", "rule.meta.references", context),
  });
}

function cloneRule(
  rule: unknown,
  context: { readonly packId: string; readonly packVersion: string },
): Rule {
  const record = assertPlainRecord(rule, "rule", RULE_KEYS, context);
  const meta = cloneRuleMeta(record.meta, context);
  const evaluate = Object.hasOwn(record, "evaluate") ? record.evaluate : undefined;
  if (typeof evaluate !== "function") {
    packError("expected a function", {
      ...context,
      field: `rule ${meta.id} evaluate`,
      value: evaluate,
    });
  }
  return Object.freeze({
    meta,
    evaluate: evaluate as Rule["evaluate"],
  });
}

function assertStatelessPattern(
  pattern: RegExp,
  packId: string,
  locale: Locale,
  group: string,
): void {
  if (!pattern.global && !pattern.sticky) return;
  throw new RulePackError(
    `Rule pack ${packId} dictionary ${locale}.${group} contains stateful RegExp /${pattern.source}/${pattern.flags}`,
  );
}

function clonePatternGroup(packId: string, locale: Locale, group: PatternGroup): PatternGroup {
  const merged = createStringRecord<readonly RegExp[]>();
  for (const key of Reflect.ownKeys(group)) {
    if (typeof key !== "string") {
      packError("symbol dictionary group names are not supported", {
        packId,
        field: `dictionary.${locale}`,
        value: group,
      });
    }
    const name = key;
    const patterns = group[name];
    const densePatterns = assertDenseArray(patterns, `dictionary.${locale}.${name}`, { packId });
    if (!Array.isArray(densePatterns)) {
      packError("expected an array of RegExp", {
        packId,
        field: `dictionary.${locale}.${name}`,
        value: patterns,
      });
    }
    const seen = new Set<string>();
    const next: RegExp[] = [];
    for (let index = 0; index < densePatterns.length; index += 1) {
      const pattern = densePatterns[index];
      if (!(pattern instanceof RegExp)) {
        packError("expected RegExp", {
          packId,
          field: `dictionary.${locale}.${name}[${index}]`,
          value: pattern,
        });
      }
      assertStatelessPattern(pattern, packId, locale, name);
      const key = `${pattern.source}\u0000${pattern.flags}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(Object.freeze(new RegExp(pattern.source, pattern.flags)));
    }
    merged[name] = Object.freeze(next);
  }
  return Object.freeze(merged);
}

function mergeDictionary(
  base: KeywordDictionary,
  addition: unknown,
  packId: string,
): KeywordDictionary {
  if (addition === undefined) return base;
  if (!isPlainRecord(addition)) {
    packError("expected a plain object", { packId, field: "dictionary", value: addition });
  }
  const next = createStringRecord<Record<string, readonly RegExp[]>>();
  if (base.en) {
    next.en = createStringRecord<readonly RegExp[]>();
    for (const [name, patterns] of Object.entries(base.en)) {
      next.en[name] = patterns;
    }
  }
  if (base.ja) {
    next.ja = createStringRecord<readonly RegExp[]>();
    for (const [name, patterns] of Object.entries(base.ja)) {
      next.ja[name] = patterns;
    }
  }

  for (const key of Reflect.ownKeys(addition)) {
    if (typeof key !== "string") {
      packError("symbol dictionary locales are not supported", {
        packId,
        field: "dictionary",
        value: addition,
      });
    }
    const localeKey = key;
    const group = addition[localeKey];
    if (!VALID_LOCALES.has(localeKey)) {
      packError("expected locale en or ja", {
        packId,
        field: `dictionary.${localeKey}`,
        value: group,
      });
    }
    if (!isPlainRecord(group)) {
      packError("expected a plain object of pattern arrays", {
        packId,
        field: `dictionary.${localeKey}`,
        value: group,
      });
    }
    const locale = localeKey as Locale;
    const target = next[locale] ?? createStringRecord<readonly RegExp[]>();
    const clonedGroup = clonePatternGroup(packId, locale, group as PatternGroup);
    for (const [name, patterns] of Object.entries(clonedGroup)) {
      const existing = readOwnStringValue(target, name) ?? [];
      const seen = new Set(existing.map((pattern) => `${pattern.source}\u0000${pattern.flags}`));
      const merged = [...existing];
      for (const pattern of patterns) {
        const key = `${pattern.source}\u0000${pattern.flags}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(pattern);
      }
      target[name] = Object.freeze(merged);
    }
    next[locale] = target;
  }

  const result = createStringRecord<PatternGroup>();
  if (next.en) result.en = Object.freeze(next.en);
  if (next.ja) result.ja = Object.freeze(next.ja);
  return Object.freeze({
    ...(result.en ? { en: result.en } : {}),
    ...(result.ja ? { ja: result.ja } : {}),
  });
}

export function composeRulePacks(
  packs: readonly RulePack[],
  options: ComposeRulePacksOptions = {},
): ComposedRuleSet {
  const rawPacks = assertDenseArray(packs, "packs", {});
  const composeOptions = normalizeComposeOptions(options);
  const includeExperimental = composeOptions.includeExperimental;
  const seenPackIds = new Set<string>();
  const seenRuleIds = new Set<string>();
  const rules: Rule[] = [];
  const metas: RulePackMeta[] = [];
  let dictionary: KeywordDictionary = Object.freeze({});

  for (const pack of rawPacks) {
    const record = assertPlainRecord(pack, "pack", PACK_KEYS, {});
    const meta = validatePackMeta(record.meta);
    if (seenPackIds.has(meta.id)) {
      throw new RulePackError(`Duplicate rule pack id: ${meta.id}`);
    }
    seenPackIds.add(meta.id);

    const ruleContext = { packId: meta.id, packVersion: meta.version };
    const rawRules = assertDenseArray(record.rules, "rules", ruleContext);
    const clonedRules: Rule[] = [];
    for (let index = 0; index < rawRules.length; index += 1) {
      clonedRules.push(cloneRule(rawRules[index], ruleContext));
    }
    const clonedDictionary = mergeDictionary(Object.freeze({}), record.dictionary, meta.id);

    if (meta.status === "experimental" && !includeExperimental) continue;

    for (const rule of clonedRules) {
      if (seenRuleIds.has(rule.meta.id)) {
        throw new RulePackError(`Duplicate rule id: ${rule.meta.id}`);
      }
      seenRuleIds.add(rule.meta.id);
      rules.push(rule);
    }
    dictionary = mergeDictionary(dictionary, clonedDictionary, meta.id);
    metas.push(meta);
  }

  return Object.freeze({
    rules: Object.freeze([...rules]),
    dictionary,
    rulePacks: Object.freeze(metas),
  });
}

function snapshotRulePackReferences(
  rulePacks: readonly RulePackMeta[],
): readonly RulePackReference[] {
  return Object.freeze(
    rulePacks.map((pack) =>
      Object.freeze({
        id: pack.id,
        version: pack.version,
      }),
    ),
  );
}

function formatKnownRuleIds(ruleIds: readonly string[]): string {
  if (ruleIds.length === 0) return "none";
  const sorted = [...ruleIds].sort();
  const visible = sorted.slice(0, 20);
  const more = sorted.length - visible.length;
  return more > 0 ? `${visible.join(", ")} ...and ${more} more` : visible.join(", ");
}

function validateRequestedRuleIds(policy: NormalizedScannerPolicy, rules: readonly Rule[]): void {
  const knownRuleIds = rules.map((rule) => rule.meta.id);
  const known = new Set(knownRuleIds);
  for (const ruleId of policy.requestedRuleOverrideIds) {
    if (!known.has(ruleId)) {
      throw new ScannerPolicyError(
        `Unknown rule override id "${ruleId}". Known rule ids: ${formatKnownRuleIds(knownRuleIds)}.`,
        `ruleOverrides.${ruleId}`,
      );
    }
  }
  for (const ruleId of policy.requestedSeverityOverrideIds) {
    if (!known.has(ruleId)) {
      throw new ScannerPolicyError(
        `Unknown severity override id "${ruleId}". Known rule ids: ${formatKnownRuleIds(knownRuleIds)}.`,
        `severityOverrides.${ruleId}`,
      );
    }
  }
}

export function createScanner(options: CreateScannerOptions): FairuxScanner {
  const normalized = normalizeCreateScannerOptions(options);
  const { policy } = normalized;
  const composed = composeRulePacks(normalized.rulePacks, {
    includeExperimental: policy.includeExperimental,
  });
  validateRequestedRuleIds(policy, composed.rules);
  const rulePacks = composed.rulePacks;
  const rulePackRefs = snapshotRulePackReferences(rulePacks);
  const scanOptions = {
    dictionary: composed.dictionary,
    includeExperimental: policy.includeExperimental,
    locale: policy.locale,
    now: policy.now,
    ruleOverrides: policy.ruleOverrides,
    rulePacks: rulePackRefs,
    toolVersion: policy.toolVersion,
  };

  return Object.freeze({
    rulePacks,
    scan: (document: UiDocument): FairUxReport => {
      return scan(document, composed.rules, scanOptions);
    },
  });
}
