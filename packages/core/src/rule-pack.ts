import { isLocaleTag } from "./locale.js";
import { withCanonicalPageContexts } from "./page-context-signal.js";
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
  CategoryDefinition,
  ComposedRuleSet,
  CreateScannerOptions,
  FairUxReport,
  FairuxScanner,
  KeywordDictionary,
  Locale,
  PageContextDefinition,
  PatternGroup,
  Rule,
  RuleMeta,
  RulePack,
  RulePackMeta,
  RulePackReference,
  RulePackTaxonomy,
  UiDocument,
} from "./types.js";

const SUPPORTED_ENGINE_API_VERSION = "1";
const BUILTIN_CATEGORIES = new Set([
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
const VALID_SEVERITY = new Set(["info", "low", "medium", "high"]);
const VALID_STATUSES = new Set(["stable", "experimental"]);
const PACK_KEYS = new Set(["meta", "taxonomy", "rules", "dictionary"]);
const PACK_META_KEYS = new Set([
  "id",
  "version",
  "engineApiVersion",
  "title",
  "description",
  "status",
]);
const TAXONOMY_KEYS = new Set(["categories", "pageContexts"]);
const CATEGORY_DEFINITION_KEYS = new Set(["id", "title", "description", "parentId"]);
const PAGE_CONTEXT_DEFINITION_KEYS = new Set(["id", "title", "description"]);
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
const BUILTIN_PAGE_CONTEXTS = new Set([
  "pricing",
  "checkout",
  "subscription",
  "account-settings",
  "consent",
  "marketing",
  "unknown",
]);
const NAMESPACED_ID_RE =
  /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\/[a-z0-9][a-z0-9-]*(?:[/:][a-z0-9][a-z0-9-]*)*$/;
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

function isBuiltinCategory(value: string): boolean {
  return BUILTIN_CATEGORIES.has(value);
}

function isBuiltinPageContext(value: string): boolean {
  return BUILTIN_PAGE_CONTEXTS.has(value);
}

function isNamespacedId(value: string): boolean {
  return NAMESPACED_ID_RE.test(value);
}

function namespaceOf(value: string): string {
  const withoutNpmScope = value.startsWith("@") ? value.slice(1) : value;
  return withoutNpmScope.split("/", 1)[0] ?? withoutNpmScope;
}

function validateNamespacedId(
  value: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): void {
  if (isNamespacedId(value)) return;
  packError("expected a namespaced id such as purchase-guard/return-policy", {
    ...context,
    field,
    value,
  });
}

function validatePackNamespace(
  id: string,
  field: string,
  context: { readonly packId: string; readonly packVersion: string },
): void {
  if (namespaceOf(id) === namespaceOf(context.packId)) return;
  packError(`expected namespace ${namespaceOf(context.packId)}`, {
    ...context,
    field,
    value: id,
  });
}

function validateLocaleId(
  value: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): void {
  if (isLocaleTag(value)) return;
  packError("expected a well-formed RFC 5646 language tag", { ...context, field, value });
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

interface PackTaxonomyContext {
  readonly packId: string;
  readonly packVersion: string;
  readonly categories: ReadonlySet<string>;
  readonly pageContexts: ReadonlySet<string>;
}

function cloneAppliesTo(
  record: Record<string, unknown>,
  context: PackTaxonomyContext,
): RuleMeta["appliesTo"] {
  const value = Object.hasOwn(record, "appliesTo") ? record.appliesTo : undefined;
  if (value === undefined) return undefined;
  const dense = assertDenseArray(value, "rule.meta.appliesTo", context);
  const output: Array<NonNullable<RuleMeta["appliesTo"]>[number]> = [];
  for (let index = 0; index < dense.length; index += 1) {
    const item = dense[index];
    if (typeof item !== "string") {
      packError("expected a valid page context", {
        ...context,
        field: `rule.meta.appliesTo[${index}]`,
        value: item,
      });
    }
    if (isBuiltinPageContext(item)) {
      output.push(item as NonNullable<RuleMeta["appliesTo"]>[number]);
      continue;
    }
    validateNamespacedId(item, `rule.meta.appliesTo[${index}]`, context);
    validatePackNamespace(item, `rule.meta.appliesTo[${index}]`, context);
    if (!context.pageContexts.has(item)) {
      packError("external page context must be declared in pack taxonomy", {
        ...context,
        field: `rule.meta.appliesTo[${index}]`,
        value: item,
      });
    }
    output.push(item as NonNullable<RuleMeta["appliesTo"]>[number]);
  }
  return Object.freeze(output) as RuleMeta["appliesTo"];
}

function cloneCategoryDefinition(
  value: unknown,
  index: number,
  context: { readonly packId: string; readonly packVersion: string },
): CategoryDefinition {
  const field = `taxonomy.categories[${index}]`;
  const record = assertPlainRecord(value, field, CATEGORY_DEFINITION_KEYS, context);
  const id = readNonEmptyString(record, "id", context);
  if (isBuiltinCategory(id)) {
    packError("built-in category ids are reserved", {
      ...context,
      field: `${field}.id`,
      value: id,
    });
  }
  validateNamespacedId(id, `${field}.id`, context);
  validatePackNamespace(id, `${field}.id`, context);
  const parentId = readOptionalString(record, "parentId", context);
  if (parentId !== undefined && !isBuiltinCategory(parentId)) {
    validateNamespacedId(parentId, `${field}.parentId`, context);
    validatePackNamespace(parentId, `${field}.parentId`, context);
  }
  return Object.freeze({
    id: id as CategoryDefinition["id"],
    title: readNonEmptyString(record, "title", context),
    description: readOptionalString(record, "description", context),
    ...(parentId !== undefined ? { parentId: parentId as CategoryDefinition["parentId"] } : {}),
  });
}

function clonePageContextDefinition(
  value: unknown,
  index: number,
  context: { readonly packId: string; readonly packVersion: string },
): PageContextDefinition {
  const field = `taxonomy.pageContexts[${index}]`;
  const record = assertPlainRecord(value, field, PAGE_CONTEXT_DEFINITION_KEYS, context);
  const id = readNonEmptyString(record, "id", context);
  if (isBuiltinPageContext(id)) {
    packError("built-in page context ids are reserved", {
      ...context,
      field: `${field}.id`,
      value: id,
    });
  }
  validateNamespacedId(id, `${field}.id`, context);
  validatePackNamespace(id, `${field}.id`, context);
  return Object.freeze({
    id: id as PageContextDefinition["id"],
    title: readNonEmptyString(record, "title", context),
    description: readOptionalString(record, "description", context),
  });
}

function cloneTaxonomy(
  taxonomy: unknown,
  context: { readonly packId: string; readonly packVersion: string },
): RulePackTaxonomy | undefined {
  if (taxonomy === undefined) return undefined;
  const record = assertPlainRecord(taxonomy, "taxonomy", TAXONOMY_KEYS, context);
  const rawCategories = Object.hasOwn(record, "categories") ? record.categories : undefined;
  const rawPageContexts = Object.hasOwn(record, "pageContexts") ? record.pageContexts : undefined;
  const categories =
    rawCategories === undefined
      ? undefined
      : assertDenseArray(rawCategories, "taxonomy.categories", context).map((item, index) =>
          cloneCategoryDefinition(item, index, context),
        );
  const pageContexts =
    rawPageContexts === undefined
      ? undefined
      : assertDenseArray(rawPageContexts, "taxonomy.pageContexts", context).map((item, index) =>
          clonePageContextDefinition(item, index, context),
        );
  validateCategoryParents(categories ?? [], context);
  validatePageContextDefinitions(pageContexts ?? []);
  return Object.freeze({
    ...(categories !== undefined
      ? { categories: Object.freeze(categories) as readonly CategoryDefinition[] }
      : {}),
    ...(pageContexts !== undefined
      ? { pageContexts: Object.freeze(pageContexts) as readonly PageContextDefinition[] }
      : {}),
  });
}

function validatePageContextDefinitions(pageContexts: readonly PageContextDefinition[]): void {
  const pageContextIds = new Set<string>();
  for (const pageContext of pageContexts) {
    if (pageContextIds.has(pageContext.id)) {
      throw new RulePackError(`Duplicate taxonomy page context id: ${pageContext.id}`);
    }
    pageContextIds.add(pageContext.id);
  }
}

function validateCategoryParents(
  categories: readonly CategoryDefinition[],
  context: { readonly packId: string; readonly packVersion: string },
): void {
  const categoryIds = new Set<string>();
  for (const category of categories) {
    if (categoryIds.has(category.id)) {
      throw new RulePackError(`Duplicate taxonomy category id: ${category.id}`);
    }
    categoryIds.add(category.id);
  }

  for (const category of categories) {
    const parentId = category.parentId;
    if (parentId === undefined || isBuiltinCategory(parentId)) continue;
    if (!categoryIds.has(parentId)) {
      packError("parent category must be declared in the same rule pack", {
        ...context,
        field: `taxonomy.categories.${category.id}.parentId`,
        value: parentId,
      });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const parentById = new Map<string, string>(
    categories
      .filter(
        (category) => category.parentId !== undefined && !isBuiltinCategory(category.parentId),
      )
      .map((category) => [category.id, category.parentId as string]),
  );

  const visit = (categoryId: string, path: readonly string[]): void => {
    if (visited.has(categoryId)) return;
    if (visiting.has(categoryId)) {
      throw new RulePackError(
        `Rule pack ${context.packId}@${context.packVersion} has cyclic taxonomy category parents: ${[...path, categoryId].join(" -> ")}`,
      );
    }
    visiting.add(categoryId);
    const parentId = parentById.get(categoryId);
    if (parentId !== undefined) visit(parentId, [...path, categoryId]);
    visiting.delete(categoryId);
    visited.add(categoryId);
  };

  for (const category of categories) visit(category.id, []);
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

function cloneRuleMeta(meta: unknown, context: PackTaxonomyContext): RuleMeta {
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
    category: readCategory(record, context),
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

function readCategory(
  record: Record<string, unknown>,
  context: PackTaxonomyContext,
): RuleMeta["category"] {
  const value = Object.hasOwn(record, "category") ? record.category : undefined;
  if (typeof value !== "string") {
    packError("expected a category id", { ...context, field: "rule.meta.category", value });
  }
  if (isBuiltinCategory(value)) return value as RuleMeta["category"];
  validateNamespacedId(value, "rule.meta.category", context);
  validatePackNamespace(value, "rule.meta.category", context);
  if (!context.categories.has(value)) {
    packError("external category must be declared in pack taxonomy", {
      ...context,
      field: "rule.meta.category",
      value,
    });
  }
  return value as RuleMeta["category"];
}

function cloneRule(rule: unknown, context: PackTaxonomyContext): Rule {
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
  locale: string,
  group: string,
): void {
  if (!pattern.global && !pattern.sticky) return;
  throw new RulePackError(
    `Rule pack ${packId} dictionary ${locale}.${group} contains stateful RegExp /${pattern.source}/${pattern.flags}`,
  );
}

function clonePatternGroup(packId: string, locale: string, group: PatternGroup): PatternGroup {
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
  for (const [locale, group] of Object.entries(base)) {
    if (!group) continue;
    const target = createStringRecord<readonly RegExp[]>();
    for (const [name, patterns] of Object.entries(group)) {
      target[name] = patterns;
    }
    next[locale] = target;
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
    validateLocaleId(localeKey, `dictionary.${localeKey}`, { packId });
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
  for (const [locale, group] of Object.entries(next)) {
    result[locale] = Object.freeze(group);
  }
  return Object.freeze(result);
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
  const seenExternalCategories = new Set<string>();
  const seenExternalPageContexts = new Set<string>();
  const rules: Rule[] = [];
  const metas: RulePackMeta[] = [];
  const categories: CategoryDefinition[] = [];
  const pageContexts: PageContextDefinition[] = [];
  let dictionary: KeywordDictionary = Object.freeze({});

  for (const pack of rawPacks) {
    const record = assertPlainRecord(pack, "pack", PACK_KEYS, {});
    const meta = validatePackMeta(record.meta);
    if (seenPackIds.has(meta.id)) {
      throw new RulePackError(`Duplicate rule pack id: ${meta.id}`);
    }
    seenPackIds.add(meta.id);

    const baseContext = { packId: meta.id, packVersion: meta.version };
    const taxonomy = cloneTaxonomy(record.taxonomy, baseContext);
    const packCategories = new Set<string>();
    const packPageContexts = new Set<string>();
    for (const category of taxonomy?.categories ?? []) {
      packCategories.add(category.id);
    }
    for (const pageContext of taxonomy?.pageContexts ?? []) {
      packPageContexts.add(pageContext.id);
    }

    const ruleContext = {
      ...baseContext,
      categories: packCategories,
      pageContexts: packPageContexts,
    };
    const rawRules = assertDenseArray(record.rules, "rules", ruleContext);
    const clonedRules: Rule[] = [];
    for (let index = 0; index < rawRules.length; index += 1) {
      clonedRules.push(cloneRule(rawRules[index], ruleContext));
    }
    const clonedDictionary = mergeDictionary(Object.freeze({}), record.dictionary, meta.id);

    if (meta.status === "experimental" && !includeExperimental) continue;

    for (const category of taxonomy?.categories ?? []) {
      if (seenExternalCategories.has(category.id)) {
        throw new RulePackError(`Duplicate taxonomy category id: ${category.id}`);
      }
      seenExternalCategories.add(category.id);
      categories.push(category);
    }
    for (const pageContext of taxonomy?.pageContexts ?? []) {
      if (seenExternalPageContexts.has(pageContext.id)) {
        throw new RulePackError(`Duplicate taxonomy page context id: ${pageContext.id}`);
      }
      seenExternalPageContexts.add(pageContext.id);
      pageContexts.push(pageContext);
    }

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
    taxonomy: Object.freeze({
      categories: Object.freeze([...categories]),
      pageContexts: Object.freeze([...pageContexts]),
    }),
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
  const declaredExternalContexts = new Set(
    composed.taxonomy.pageContexts.map((context) => context.id),
  );
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
    taxonomy: composed.taxonomy,
    scan: (document: UiDocument): FairUxReport => {
      return scan(
        withCanonicalPageContexts(document, { declaredExternalContexts }),
        composed.rules,
        scanOptions,
      );
    },
  });
}
