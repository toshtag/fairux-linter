import { isBuiltinJurisdictionId } from "./jurisdiction.js";
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
  CapabilityId,
  CategoryDefinition,
  ComposedRuleSet,
  CreateScannerOptions,
  EvidenceRequirement,
  FairUxReport,
  FairuxScanner,
  JurisdictionId,
  KeywordDictionary,
  Locale,
  OfficialSource,
  PageContextDefinition,
  PatternGroup,
  ReadonlyNonEmptyArray,
  Rule,
  RuleDeprecation,
  RuleMaturity,
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
const VALID_MATURITY = new Set(["draft", "experimental", "stable", "deprecated"]);
const BUILTIN_CAPABILITIES = new Set([
  "structure",
  "text",
  "attributes",
  "source-location",
  "dom-state",
  "style-hints",
  "computed-style",
  "viewport",
  "interaction",
  "journey",
  "form",
  "network",
]);
const VALID_EVIDENCE_REQUIREMENTS = new Set([
  "presence",
  "absence",
  "text-match",
  "attribute-state",
  "comparison",
  "runtime-state",
  "sequence",
  "network-observation",
]);
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
  "maturity",
  "requiredCapabilities",
  "optionalCapabilities",
  "evidenceRequirements",
  "jurisdictions",
  "officialSources",
  "knownLimitations",
  "deprecation",
]);
const OFFICIAL_SOURCE_KEYS = new Set([
  "id",
  "title",
  "publisher",
  "url",
  "jurisdictions",
  "reviewedAt",
]);
const DEPRECATION_KEYS = new Set(["since", "reason", "replacementRuleId", "removalTarget"]);
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
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

declare const URL: {
  new (
    input: string,
  ): {
    readonly href: string;
    readonly password: string;
    readonly protocol: string;
    readonly username: string;
  };
};

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

interface ParsedSemver {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease?: readonly string[];
}

function parseSemver(value: string): ParsedSemver {
  const match = SEMVER_RE.exec(value);
  if (!match) throw new Error(`invalid semver: ${value}`);
  return {
    major: match[1] as string,
    minor: match[2] as string,
    patch: match[3] as string,
    prerelease: match[4]?.split("."),
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^(0|[1-9]\d*)$/.test(a);
    const bNumeric = /^(0|[1-9]\d*)$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = compareNumericIdentifier(a, b);
      if (diff !== 0) return diff;
      continue;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  const major = compareNumericIdentifier(a.major, b.major);
  if (major !== 0) return major;
  const minor = compareNumericIdentifier(a.minor, b.minor);
  if (minor !== 0) return minor;
  const patch = compareNumericIdentifier(a.patch, b.patch);
  if (patch !== 0) return patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function hasForbiddenPublicCodePoint(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
    if (codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f) return true;
    if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
    if (codePoint >= 0x2066 && codePoint <= 0x2069) return true;
  }
  return false;
}

function assertPublicString(
  value: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): void {
  if (hasForbiddenPublicCodePoint(value)) {
    packError("control and bidirectional formatting characters are not supported", {
      ...context,
      field,
      value,
    });
  }
}

function assertTrimmedNonEmptyPublicString(
  value: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): void {
  if (value.length === 0 || value.trim() !== value) {
    packError("expected a non-empty string with no leading or trailing whitespace", {
      ...context,
      field,
      value,
    });
  }
  assertPublicString(value, field, context);
}

function isValidCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_RE.test(value)) return false;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
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

function isValidCapabilityId(value: string): boolean {
  if (BUILTIN_CAPABILITIES.has(value)) return true;
  if (!isNamespacedId(value)) return false;
  const terminal = value.split(/[/:]/).at(-1);
  return terminal === undefined || !BUILTIN_CAPABILITIES.has(terminal);
}

function validateJurisdictionId(
  value: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): void {
  assertTrimmedNonEmptyPublicString(value, field, context);
  if (isBuiltinJurisdictionId(value) || isNamespacedId(value)) return;
  packError("expected global, EU, EEA, an uppercase ISO 3166-1 alpha-2 code, or a namespaced id", {
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

function cloneRequiredStringArray(
  record: Record<string, unknown>,
  property: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): ReadonlyNonEmptyArray<string> {
  const value = Object.hasOwn(record, property) ? record[property] : undefined;
  const output = cloneStringArray(value, field, context);
  if (output.length > 0) return output as unknown as ReadonlyNonEmptyArray<string>;
  packError("expected at least one item", { ...context, field, value });
}

function cloneNonEmptyOptionalStringArray(
  record: Record<string, unknown>,
  property: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): ReadonlyNonEmptyArray<string> | undefined {
  const value = Object.hasOwn(record, property) ? record[property] : undefined;
  if (value === undefined) return undefined;
  const output = cloneStringArray(value, field, context);
  if (output.length > 0) return output as unknown as ReadonlyNonEmptyArray<string>;
  packError("expected at least one item when present", { ...context, field, value });
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

function rejectDuplicateStrings(
  values: readonly string[],
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      continue;
    }
    packError("duplicate values are not supported", { ...context, field, value });
  }
}

function cloneCapabilityArray(
  record: Record<string, unknown>,
  property: "requiredCapabilities",
  context: { readonly packId?: string; readonly packVersion?: string },
): ReadonlyNonEmptyArray<CapabilityId>;
function cloneCapabilityArray(
  record: Record<string, unknown>,
  property: "optionalCapabilities",
  context: { readonly packId?: string; readonly packVersion?: string },
): ReadonlyNonEmptyArray<CapabilityId> | undefined;
function cloneCapabilityArray(
  record: Record<string, unknown>,
  property: "requiredCapabilities" | "optionalCapabilities",
  context: { readonly packId?: string; readonly packVersion?: string },
): ReadonlyNonEmptyArray<CapabilityId> | undefined {
  const field = `rule.meta.${property}`;
  const output =
    property === "requiredCapabilities"
      ? cloneRequiredStringArray(record, property, field, context)
      : cloneNonEmptyOptionalStringArray(record, property, field, context);
  if (output === undefined) return undefined;
  for (let index = 0; index < output.length; index += 1) {
    const value = output[index] as string;
    if (isValidCapabilityId(value)) continue;
    packError("expected a built-in capability id or namespaced capability id", {
      ...context,
      field: `${field}[${index}]`,
      value,
    });
  }
  rejectDuplicateStrings(output, field, context);
  return Object.freeze(output) as unknown as ReadonlyNonEmptyArray<CapabilityId>;
}

function cloneEvidenceRequirements(
  record: Record<string, unknown>,
  context: { readonly packId?: string; readonly packVersion?: string },
): ReadonlyNonEmptyArray<EvidenceRequirement> {
  const output = cloneRequiredStringArray(
    record,
    "evidenceRequirements",
    "rule.meta.evidenceRequirements",
    context,
  );
  for (let index = 0; index < output.length; index += 1) {
    const value = output[index] as string;
    if (VALID_EVIDENCE_REQUIREMENTS.has(value)) continue;
    packError(`expected one of ${Array.from(VALID_EVIDENCE_REQUIREMENTS).join(", ")}`, {
      ...context,
      field: `rule.meta.evidenceRequirements[${index}]`,
      value,
    });
  }
  rejectDuplicateStrings(output, "rule.meta.evidenceRequirements", context);
  return Object.freeze(output) as unknown as ReadonlyNonEmptyArray<EvidenceRequirement>;
}

function cloneJurisdictions(
  record: Record<string, unknown>,
  property: "jurisdictions",
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): ReadonlyNonEmptyArray<JurisdictionId> | undefined {
  const output = cloneNonEmptyOptionalStringArray(record, property, field, context);
  if (output === undefined) return undefined;
  for (let index = 0; index < output.length; index += 1) {
    validateJurisdictionId(output[index] as string, `${field}[${index}]`, context);
  }
  rejectDuplicateStrings(output, field, context);
  return Object.freeze(output) as unknown as ReadonlyNonEmptyArray<JurisdictionId>;
}

interface PackTaxonomyContext {
  readonly packId: string;
  readonly packVersion: string;
  readonly packStatus: RulePackMeta["status"];
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

function canonicalHttpsUrl(
  value: string,
  field: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): string {
  if (value.trim() !== value) {
    packError("expected no leading or trailing whitespace", { ...context, field, value });
  }
  assertPublicString(value, field, context);
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(value);
  } catch {
    packError("expected an absolute HTTPS URL", { ...context, field, value });
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    packError("expected an absolute HTTPS URL without credentials", {
      ...context,
      field,
      value,
    });
  }
  return url.href;
}

function cloneOfficialSource(
  value: unknown,
  index: number,
  context: { readonly packId?: string; readonly packVersion?: string },
): OfficialSource {
  const field = `rule.meta.officialSources[${index}]`;
  const record = assertPlainRecord(value, field, OFFICIAL_SOURCE_KEYS, context);
  const id = readNonEmptyString(record, "id", context);
  validateNamespacedId(id, `${field}.id`, context);
  const title = readNonEmptyString(record, "title", context);
  const publisher = readNonEmptyString(record, "publisher", context);
  assertTrimmedNonEmptyPublicString(title, `${field}.title`, context);
  assertTrimmedNonEmptyPublicString(publisher, `${field}.publisher`, context);
  const url = canonicalHttpsUrl(
    readNonEmptyString(record, "url", context),
    `${field}.url`,
    context,
  );
  const reviewedAt = readNonEmptyString(record, "reviewedAt", context);
  if (!isValidCalendarDate(reviewedAt)) {
    packError("expected a valid YYYY-MM-DD calendar date", {
      ...context,
      field: `${field}.reviewedAt`,
      value: reviewedAt,
    });
  }
  const jurisdictions = cloneJurisdictions(
    record,
    "jurisdictions",
    `${field}.jurisdictions`,
    context,
  );
  return Object.freeze({
    id: id as OfficialSource["id"],
    title,
    publisher,
    url,
    ...(jurisdictions !== undefined ? { jurisdictions } : {}),
    reviewedAt,
  });
}

function cloneOfficialSources(
  record: Record<string, unknown>,
  context: { readonly packId?: string; readonly packVersion?: string },
): ReadonlyNonEmptyArray<OfficialSource> | undefined {
  const value = Object.hasOwn(record, "officialSources") ? record.officialSources : undefined;
  if (value === undefined) return undefined;
  const dense = assertDenseArray(value, "rule.meta.officialSources", context);
  if (dense.length === 0) {
    packError("expected at least one item when present", {
      ...context,
      field: "rule.meta.officialSources",
      value,
    });
  }
  const output = dense.map((item, index) => cloneOfficialSource(item, index, context));
  const sourceIds = new Set<string>();
  const urls = new Set<string>();
  for (const source of output) {
    if (sourceIds.has(source.id)) {
      packError("duplicate source ids are not supported within one rule", {
        ...context,
        field: "rule.meta.officialSources",
        value: source.id,
      });
    }
    sourceIds.add(source.id);
    if (urls.has(source.url)) {
      packError("duplicate canonical source URLs are not supported within one rule", {
        ...context,
        field: "rule.meta.officialSources",
        value: source.url,
      });
    }
    urls.add(source.url);
  }
  return Object.freeze(output) as unknown as ReadonlyNonEmptyArray<OfficialSource>;
}

function cloneDeprecation(
  value: unknown,
  packVersion: string,
  context: { readonly packId?: string; readonly packVersion?: string },
): RuleDeprecation {
  const record = assertPlainRecord(value, "rule.meta.deprecation", DEPRECATION_KEYS, context);
  const since = readNonEmptyString(record, "since", context);
  validateSemver(since, "rule.meta.deprecation.since", context);
  if (compareSemver(since, packVersion) > 0) {
    packError("since must be less than or equal to the containing RulePack version", {
      ...context,
      field: "rule.meta.deprecation.since",
      value: since,
    });
  }
  const reason = readNonEmptyString(record, "reason", context);
  assertTrimmedNonEmptyPublicString(reason, "rule.meta.deprecation.reason", context);
  const replacementRuleId = readOptionalString(record, "replacementRuleId", context);
  if (replacementRuleId !== undefined) {
    assertTrimmedNonEmptyPublicString(
      replacementRuleId,
      "rule.meta.deprecation.replacementRuleId",
      context,
    );
  }
  const removalTarget = readOptionalString(record, "removalTarget", context);
  if (removalTarget !== undefined) {
    validateSemver(removalTarget, "rule.meta.deprecation.removalTarget", context);
    if (
      compareSemver(removalTarget, packVersion) <= 0 ||
      compareSemver(removalTarget, since) <= 0
    ) {
      packError("removalTarget must be greater than both the pack version and since", {
        ...context,
        field: "rule.meta.deprecation.removalTarget",
        value: removalTarget,
      });
    }
  }
  return Object.freeze({
    since,
    reason,
    ...(replacementRuleId !== undefined ? { replacementRuleId } : {}),
    ...(removalTarget !== undefined ? { removalTarget } : {}),
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
  const maturity = readEnum<RuleMaturity>(record, "maturity", VALID_MATURITY, context);
  const experimental =
    (Object.hasOwn(record, "experimental") ? record.experimental : undefined) === undefined
      ? undefined
      : readBoolean(record, "experimental", context);
  const defaultEnabled = readBoolean(record, "defaultEnabled", context);
  if ((maturity === "draft" || maturity === "experimental") && experimental !== true) {
    packError("draft and experimental maturity rules must use experimental: true", {
      ...context,
      field: "rule.meta.experimental",
      value: experimental,
    });
  }
  if ((maturity === "draft" || maturity === "experimental") && defaultEnabled !== false) {
    packError("draft and experimental maturity rules must use defaultEnabled: false", {
      ...context,
      field: "rule.meta.defaultEnabled",
      value: defaultEnabled,
    });
  }
  if (maturity === "stable" && experimental === true) {
    packError("stable maturity rules must not use experimental: true", {
      ...context,
      field: "rule.meta.experimental",
      value: experimental,
    });
  }
  if (context.packStatus === "stable" && maturity === "draft") {
    packError("stable RulePacks must not contain draft rules", {
      ...context,
      field: "rule.meta.maturity",
      value: maturity,
    });
  }
  const rawDeprecation = Object.hasOwn(record, "deprecation") ? record.deprecation : undefined;
  if (maturity === "deprecated" && rawDeprecation === undefined) {
    packError("deprecated rules require deprecation metadata", {
      ...context,
      field: "rule.meta.deprecation",
      value: rawDeprecation,
    });
  }
  if (maturity !== "deprecated" && rawDeprecation !== undefined) {
    packError("non-deprecated rules must not carry deprecation metadata", {
      ...context,
      field: "rule.meta.deprecation",
      value: rawDeprecation,
    });
  }
  const requiredCapabilities = cloneCapabilityArray(record, "requiredCapabilities", context);
  const optionalCapabilities = cloneCapabilityArray(record, "optionalCapabilities", context);
  if (requiredCapabilities === undefined) {
    packError("expected at least one required capability", {
      ...context,
      field: "rule.meta.requiredCapabilities",
      value: undefined,
    });
  }
  if (optionalCapabilities !== undefined) {
    const required = new Set(requiredCapabilities);
    for (const capability of optionalCapabilities) {
      if (!required.has(capability)) continue;
      packError("required and optional capabilities must not overlap", {
        ...context,
        field: "rule.meta.optionalCapabilities",
        value: capability,
      });
    }
  }
  const evidenceRequirements = cloneEvidenceRequirements(record, context);
  const jurisdictions = cloneJurisdictions(
    record,
    "jurisdictions",
    "rule.meta.jurisdictions",
    context,
  );
  const officialSources = cloneOfficialSources(record, context);
  const knownLimitations = cloneNonEmptyOptionalStringArray(
    record,
    "knownLimitations",
    "rule.meta.knownLimitations",
    context,
  );
  if (knownLimitations !== undefined) {
    for (let index = 0; index < knownLimitations.length; index += 1) {
      assertTrimmedNonEmptyPublicString(
        knownLimitations[index] as string,
        `rule.meta.knownLimitations[${index}]`,
        context,
      );
    }
    rejectDuplicateStrings(knownLimitations, "rule.meta.knownLimitations", context);
  }
  const deprecation =
    rawDeprecation === undefined
      ? undefined
      : cloneDeprecation(rawDeprecation, context.packVersion, context);
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
    defaultEnabled,
    experimental,
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
    maturity,
    requiredCapabilities,
    ...(optionalCapabilities !== undefined ? { optionalCapabilities } : {}),
    evidenceRequirements,
    ...(jurisdictions !== undefined ? { jurisdictions } : {}),
    ...(officialSources !== undefined ? { officialSources } : {}),
    ...(knownLimitations !== undefined ? { knownLimitations } : {}),
    ...(deprecation !== undefined ? { deprecation } : {}),
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

function validateDeprecationReplacements(
  rules: readonly Rule[],
  context: { readonly packId: string; readonly packVersion: string },
): void {
  const byId = new Map(rules.map((rule) => [rule.meta.id, rule]));
  const replacementByRule = new Map<string, string>();
  for (const rule of rules) {
    const replacementRuleId = rule.meta.deprecation?.replacementRuleId;
    if (replacementRuleId === undefined) continue;
    if (replacementRuleId === rule.meta.id) {
      packError("replacementRuleId must point at a different rule", {
        ...context,
        field: `rule ${rule.meta.id} deprecation.replacementRuleId`,
        value: replacementRuleId,
      });
    }
    const replacement = byId.get(replacementRuleId);
    if (!replacement) {
      packError("replacementRuleId must target a rule in the same RulePack", {
        ...context,
        field: `rule ${rule.meta.id} deprecation.replacementRuleId`,
        value: replacementRuleId,
      });
    }
    if (replacement.meta.maturity === "deprecated") {
      packError("replacementRuleId must not target a deprecated rule", {
        ...context,
        field: `rule ${rule.meta.id} deprecation.replacementRuleId`,
        value: replacementRuleId,
      });
    }
    replacementByRule.set(rule.meta.id, replacementRuleId);
  }
  for (const ruleId of replacementByRule.keys()) {
    const seen = new Set<string>();
    let cursor: string | undefined = ruleId;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        packError("replacementRuleId chains must not cycle", {
          ...context,
          field: `rule ${ruleId} deprecation.replacementRuleId`,
          value: cursor,
        });
      }
      seen.add(cursor);
      cursor = replacementByRule.get(cursor);
    }
  }
}

function validateOfficialSourceIdentityConsistency(
  rules: readonly Rule[],
  context: { readonly packId: string; readonly packVersion: string },
): void {
  const identityById = new Map<string, string>();
  for (const rule of rules) {
    for (const source of rule.meta.officialSources ?? []) {
      const identity = JSON.stringify({
        title: source.title,
        publisher: source.publisher,
        url: source.url,
      });
      const existing = identityById.get(source.id);
      if (existing === undefined) {
        identityById.set(source.id, identity);
        continue;
      }
      if (existing === identity) continue;
      packError("official source identity fields must match within one RulePack", {
        ...context,
        field: `rule ${rule.meta.id} officialSources.${source.id}`,
        value: source.id,
      });
    }
  }
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
      packStatus: meta.status,
      categories: packCategories,
      pageContexts: packPageContexts,
    };
    const rawRules = assertDenseArray(record.rules, "rules", ruleContext);
    const clonedRules: Rule[] = [];
    for (let index = 0; index < rawRules.length; index += 1) {
      clonedRules.push(cloneRule(rawRules[index], ruleContext));
    }
    validateDeprecationReplacements(clonedRules, baseContext);
    validateOfficialSourceIdentityConsistency(clonedRules, baseContext);
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
