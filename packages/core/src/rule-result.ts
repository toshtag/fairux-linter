import { RulePackError } from "./rule-pack-error.js";
import type {
  Category,
  Confidence,
  CreateFindingInput,
  Evidence,
  Finding,
  NodeLocator,
  Rule,
  Severity,
  SourceLocation,
} from "./types.js";

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
const VALID_SEVERITY = new Set(["info", "low", "medium", "high"]);
const CREATE_FINDING_KEYS = new Set([
  "evidence",
  "description",
  "whyItMatters",
  "recommendation",
  "title",
  "severity",
  "confidence",
  "references",
  "fingerprintText",
]);
const FINDING_KEYS = new Set([
  "id",
  "fingerprint",
  "batchOccurrenceId",
  "ruleId",
  "category",
  "severity",
  "confidence",
  "title",
  "description",
  "evidence",
  "whyItMatters",
  "recommendation",
  "references",
]);
const EVIDENCE_KEYS = new Set(["locator", "text", "snippet", "source"]);
const SOURCE_KEYS = new Set(["file", "startLine", "startColumn"]);
const CSS_LOCATOR_KEYS = new Set(["type", "value"]);
const PATH_LOCATOR_KEYS = new Set(["type", "value"]);
const AST_LOCATOR_KEYS = new Set(["type", "file", "startLine", "startColumn"]);
const FIGMA_LOCATOR_KEYS = new Set(["type", "nodeId"]);
const NO_VALUE = Symbol("no rule result value");
const ABSENT = Symbol("absent rule result property");

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

function fail(rule: Rule, field: string, message: string, value: unknown = NO_VALUE): never {
  const actual = value === NO_VALUE ? "" : `; received ${valueKind(value)}`;
  throw new RulePackError(`Rule ${rule.meta.id} has invalid ${field}: ${message}${actual}`);
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function assertPlainRecord(
  value: unknown,
  field: string,
  allowedKeys: ReadonlySet<string>,
  rule: Rule,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail(rule, field, "expected a plain object", value);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail(rule, field, "symbol keys are not supported", value);
    }
    if (!allowedKeys.has(key)) {
      fail(rule, `${field}.${key}`, "unknown field");
    }
  }
  return value;
}

function assertDenseArray(value: unknown, field: string, rule: Rule): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(rule, field, "expected an array", value);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      fail(rule, `${field}[${index}]`, "sparse arrays are not supported", undefined);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      fail(rule, field, "symbol array properties are not supported", value);
    }
    if (key !== "length" && !isArrayIndexKey(key, value.length)) {
      fail(rule, `${field}.${key}`, "custom array properties are not supported");
    }
  }
  return value;
}

function readOwnProperty(
  record: Record<string, unknown>,
  property: string,
  field: string,
  rule: Rule,
): unknown | typeof ABSENT {
  if (!Object.hasOwn(record, property)) return ABSENT;
  try {
    return record[property];
  } catch {
    fail(rule, field, "property getter threw while reading the value");
  }
}

function normalizeRequiredStringValue(
  value: unknown | typeof ABSENT,
  field: string,
  rule: Rule,
): string {
  if (typeof value === "string" && value.length > 0) return value;
  fail(rule, field, "expected a non-empty string", value === ABSENT ? undefined : value);
}

function normalizeOptionalStringValue(
  value: unknown | typeof ABSENT,
  field: string,
  rule: Rule,
): string | undefined {
  if (value === ABSENT || value === undefined) return undefined;
  if (typeof value === "string") return value;
  fail(rule, field, "expected a string when present", value);
}

function normalizeOptionalNumberValue(
  value: unknown | typeof ABSENT,
  field: string,
  rule: Rule,
): number | undefined {
  if (value === ABSENT || value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail(rule, field, "expected a finite number when present", value);
}

function normalizeRequiredNumberValue(
  value: unknown | typeof ABSENT,
  field: string,
  rule: Rule,
): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail(rule, field, "expected a finite number", value === ABSENT ? undefined : value);
}

function normalizeStringArray(value: unknown, field: string, rule: Rule): string[] {
  const array = assertDenseArray(value, field, rule);
  const output: string[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const item = array[index];
    if (typeof item !== "string") {
      fail(rule, `${field}[${index}]`, "expected a string", item);
    }
    output.push(item);
  }
  return Object.freeze(output) as unknown as string[];
}

function normalizeSourceLocation(value: unknown, field: string, rule: Rule): SourceLocation {
  const record = assertPlainRecord(value, field, SOURCE_KEYS, rule);
  const file = normalizeOptionalStringValue(
    readOwnProperty(record, "file", `${field}.file`, rule),
    `${field}.file`,
    rule,
  );
  const startLine = normalizeOptionalNumberValue(
    readOwnProperty(record, "startLine", `${field}.startLine`, rule),
    `${field}.startLine`,
    rule,
  );
  const startColumn = normalizeOptionalNumberValue(
    readOwnProperty(record, "startColumn", `${field}.startColumn`, rule),
    `${field}.startColumn`,
    rule,
  );

  return Object.freeze({
    ...(file !== undefined ? { file } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(startColumn !== undefined ? { startColumn } : {}),
  });
}

function normalizeNodeLocator(value: unknown, field: string, rule: Rule): NodeLocator {
  if (!isPlainRecord(value)) {
    fail(rule, field, "expected a plain object", value);
  }
  const type = readOwnProperty(value, "type", `${field}.type`, rule);
  if (type === "css") {
    const record = assertPlainRecord(value, field, CSS_LOCATOR_KEYS, rule);
    const locatorValue = normalizeRequiredStringValue(
      readOwnProperty(record, "value", `${field}.value`, rule),
      `${field}.value`,
      rule,
    );
    return Object.freeze({ type: "css", value: locatorValue });
  }
  if (type === "path") {
    const record = assertPlainRecord(value, field, PATH_LOCATOR_KEYS, rule);
    const path = assertDenseArray(
      readOwnProperty(record, "value", `${field}.value`, rule),
      `${field}.value`,
      rule,
    );
    const output: number[] = [];
    for (let index = 0; index < path.length; index += 1) {
      const part = path[index];
      if (!(typeof part === "number" && Number.isInteger(part) && part >= 0)) {
        fail(rule, `${field}.value[${index}]`, "expected a non-negative integer", part);
      }
      output.push(part);
    }
    return Object.freeze({ type: "path", value: Object.freeze(output) as unknown as number[] });
  }
  if (type === "ast") {
    const record = assertPlainRecord(value, field, AST_LOCATOR_KEYS, rule);
    const file = normalizeRequiredStringValue(
      readOwnProperty(record, "file", `${field}.file`, rule),
      `${field}.file`,
      rule,
    );
    const startLine = normalizeRequiredNumberValue(
      readOwnProperty(record, "startLine", `${field}.startLine`, rule),
      `${field}.startLine`,
      rule,
    );
    const startColumn = normalizeRequiredNumberValue(
      readOwnProperty(record, "startColumn", `${field}.startColumn`, rule),
      `${field}.startColumn`,
      rule,
    );
    return Object.freeze({ type: "ast", file, startLine, startColumn });
  }
  if (type === "figma") {
    const record = assertPlainRecord(value, field, FIGMA_LOCATOR_KEYS, rule);
    const nodeId = normalizeRequiredStringValue(
      readOwnProperty(record, "nodeId", `${field}.nodeId`, rule),
      `${field}.nodeId`,
      rule,
    );
    return Object.freeze({ type: "figma", nodeId });
  }
  fail(rule, `${field}.type`, "expected css, path, ast, or figma", type);
}

function normalizeEvidence(value: unknown, field: string, rule: Rule): Evidence {
  const record = assertPlainRecord(value, field, EVIDENCE_KEYS, rule);
  const rawLocator = readOwnProperty(record, "locator", `${field}.locator`, rule);
  const locator =
    rawLocator !== ABSENT && rawLocator !== undefined
      ? normalizeNodeLocator(rawLocator, `${field}.locator`, rule)
      : undefined;
  const text = normalizeOptionalStringValue(
    readOwnProperty(record, "text", `${field}.text`, rule),
    `${field}.text`,
    rule,
  );
  const snippet = normalizeOptionalStringValue(
    readOwnProperty(record, "snippet", `${field}.snippet`, rule),
    `${field}.snippet`,
    rule,
  );
  const rawSource = readOwnProperty(record, "source", `${field}.source`, rule);
  const source =
    rawSource !== ABSENT && rawSource !== undefined
      ? normalizeSourceLocation(rawSource, `${field}.source`, rule)
      : undefined;
  return Object.freeze({
    ...(locator !== undefined ? { locator } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(source !== undefined ? { source } : {}),
  });
}

function normalizeEvidenceArray(value: unknown, field: string, rule: Rule): Evidence[] {
  const array = assertDenseArray(value, field, rule);
  const output: Evidence[] = [];
  for (let index = 0; index < array.length; index += 1) {
    output.push(normalizeEvidence(array[index], `${field}[${index}]`, rule));
  }
  return Object.freeze(output) as unknown as Evidence[];
}

function normalizeOptionalEnumValue<T extends string>(
  value: unknown | typeof ABSENT,
  field: string,
  allowed: ReadonlySet<string>,
  rule: Rule,
): T | undefined {
  if (value === ABSENT || value === undefined) return undefined;
  if (typeof value === "string" && allowed.has(value)) return value as T;
  fail(rule, field, `expected one of ${Array.from(allowed).join(", ")}`, value);
}

function normalizeRequiredEnumValue<T extends string>(
  value: unknown | typeof ABSENT,
  field: string,
  allowed: ReadonlySet<string>,
  rule: Rule,
): T {
  if (typeof value === "string" && allowed.has(value)) return value as T;
  fail(
    rule,
    field,
    `expected one of ${Array.from(allowed).join(", ")}`,
    value === ABSENT ? undefined : value,
  );
}

export function validateCreateFindingInput(input: unknown, rule: Rule): CreateFindingInput {
  const record = assertPlainRecord(input, "createFinding input", CREATE_FINDING_KEYS, rule);
  const evidence = normalizeEvidenceArray(
    readOwnProperty(record, "evidence", "createFinding input.evidence", rule),
    "createFinding input.evidence",
    rule,
  );
  const description = normalizeRequiredStringValue(
    readOwnProperty(record, "description", "createFinding input.description", rule),
    "createFinding input.description",
    rule,
  );
  const whyItMatters = normalizeRequiredStringValue(
    readOwnProperty(record, "whyItMatters", "createFinding input.whyItMatters", rule),
    "createFinding input.whyItMatters",
    rule,
  );
  const recommendation = normalizeRequiredStringValue(
    readOwnProperty(record, "recommendation", "createFinding input.recommendation", rule),
    "createFinding input.recommendation",
    rule,
  );
  const title = normalizeOptionalStringValue(
    readOwnProperty(record, "title", "createFinding input.title", rule),
    "createFinding input.title",
    rule,
  );
  const severity = normalizeOptionalEnumValue<Severity>(
    readOwnProperty(record, "severity", "createFinding input.severity", rule),
    "createFinding input.severity",
    VALID_SEVERITY,
    rule,
  );
  const confidence = normalizeOptionalEnumValue<Confidence>(
    readOwnProperty(record, "confidence", "createFinding input.confidence", rule),
    "createFinding input.confidence",
    VALID_CONFIDENCE,
    rule,
  );
  const rawReferences = readOwnProperty(
    record,
    "references",
    "createFinding input.references",
    rule,
  );
  const references =
    rawReferences !== ABSENT && rawReferences !== undefined
      ? normalizeStringArray(rawReferences, "createFinding input.references", rule)
      : undefined;
  const fingerprintText = normalizeOptionalStringValue(
    readOwnProperty(record, "fingerprintText", "createFinding input.fingerprintText", rule),
    "createFinding input.fingerprintText",
    rule,
  );

  return Object.freeze({
    evidence,
    description,
    whyItMatters,
    recommendation,
    ...(title !== undefined ? { title } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(references !== undefined ? { references } : {}),
    ...(fingerprintText !== undefined ? { fingerprintText } : {}),
  });
}

function normalizeFinding(value: unknown, field: string, rule: Rule): Finding {
  const record = assertPlainRecord(value, field, FINDING_KEYS, rule);
  const id = normalizeRequiredStringValue(
    readOwnProperty(record, "id", `${field}.id`, rule),
    `${field}.id`,
    rule,
  );
  const fingerprint = normalizeRequiredStringValue(
    readOwnProperty(record, "fingerprint", `${field}.fingerprint`, rule),
    `${field}.fingerprint`,
    rule,
  );
  const batchOccurrenceId = normalizeOptionalStringValue(
    readOwnProperty(record, "batchOccurrenceId", `${field}.batchOccurrenceId`, rule),
    `${field}.batchOccurrenceId`,
    rule,
  );
  const ruleId = normalizeRequiredStringValue(
    readOwnProperty(record, "ruleId", `${field}.ruleId`, rule),
    `${field}.ruleId`,
    rule,
  );
  if (ruleId !== rule.meta.id) {
    fail(rule, `${field}.ruleId`, `expected ${rule.meta.id}`, ruleId);
  }
  const category = normalizeRequiredEnumValue<Category>(
    readOwnProperty(record, "category", `${field}.category`, rule),
    `${field}.category`,
    VALID_CATEGORIES,
    rule,
  );
  if (category !== rule.meta.category) {
    fail(rule, `${field}.category`, `expected ${rule.meta.category}`, category);
  }
  const severity = normalizeRequiredEnumValue<Severity>(
    readOwnProperty(record, "severity", `${field}.severity`, rule),
    `${field}.severity`,
    VALID_SEVERITY,
    rule,
  );
  const confidence = normalizeRequiredEnumValue<Confidence>(
    readOwnProperty(record, "confidence", `${field}.confidence`, rule),
    `${field}.confidence`,
    VALID_CONFIDENCE,
    rule,
  );
  const title = normalizeRequiredStringValue(
    readOwnProperty(record, "title", `${field}.title`, rule),
    `${field}.title`,
    rule,
  );
  const description = normalizeRequiredStringValue(
    readOwnProperty(record, "description", `${field}.description`, rule),
    `${field}.description`,
    rule,
  );
  const evidence = normalizeEvidenceArray(
    readOwnProperty(record, "evidence", `${field}.evidence`, rule),
    `${field}.evidence`,
    rule,
  );
  const whyItMatters = normalizeRequiredStringValue(
    readOwnProperty(record, "whyItMatters", `${field}.whyItMatters`, rule),
    `${field}.whyItMatters`,
    rule,
  );
  const recommendation = normalizeRequiredStringValue(
    readOwnProperty(record, "recommendation", `${field}.recommendation`, rule),
    `${field}.recommendation`,
    rule,
  );
  const rawReferences = readOwnProperty(record, "references", `${field}.references`, rule);
  const references =
    rawReferences !== ABSENT && rawReferences !== undefined
      ? normalizeStringArray(rawReferences, `${field}.references`, rule)
      : undefined;
  const frozenEvidence = Object.freeze([...evidence]) as unknown as Evidence[];
  const frozenReferences =
    references === undefined
      ? undefined
      : (Object.freeze([...references]) as unknown as readonly string[]);

  return Object.freeze({
    id,
    fingerprint,
    ...(batchOccurrenceId !== undefined ? { batchOccurrenceId: batchOccurrenceId as string } : {}),
    ruleId,
    category,
    severity,
    confidence,
    title,
    description,
    evidence: frozenEvidence,
    whyItMatters,
    recommendation,
    ...(frozenReferences !== undefined ? { references: frozenReferences } : {}),
  });
}

export function validateRuleFindings(value: unknown, rule: Rule): readonly Finding[] {
  const array = assertDenseArray(value, `rule ${rule.meta.id} evaluate result`, rule);
  const findings: Finding[] = [];
  for (let index = 0; index < array.length; index += 1) {
    findings.push(normalizeFinding(array[index], `rule ${rule.meta.id} findings[${index}]`, rule));
  }
  return Object.freeze(findings);
}

export function validateUniqueFindingId(
  finding: Finding,
  rule: Rule,
  seenFindingIds: Set<string>,
): void {
  if (seenFindingIds.has(finding.id)) {
    fail(rule, `finding id ${finding.id}`, "duplicate finding id");
  }
  seenFindingIds.add(finding.id);
}
