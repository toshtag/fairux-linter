import { RulePackError } from "./rule-pack-error.js";
import type {
  Category,
  Confidence,
  CreateFindingInput,
  Evidence,
  Finding,
  NodeLocator,
  Remediation,
  RemediationOrigin,
  RemediationSafety,
  Rule,
  Severity,
  SourceLocation,
  TextEdit,
} from "./types.js";

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
  "remediation",
]);
const REMEDIATION_KEYS = new Set([
  "id",
  "origin",
  "safety",
  "title",
  "description",
  "rationale",
  "file",
  "fileChecksum",
  "edits",
]);
const TEXT_EDIT_KEYS = new Set([
  "startLine",
  "startColumn",
  "endLine",
  "endColumn",
  "expected",
  "replacement",
]);
const VALID_REMEDIATION_ORIGIN = new Set(["rule", "ai"]);
const VALID_REMEDIATION_SAFETY = new Set(["safe", "review-required"]);
/** Lowercase hex, 64 characters. A checksum in any other shape was not computed the documented way. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
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
  "remediation",
]);
const EVIDENCE_KEYS = new Set(["locator", "text", "snippet", "source"]);
/**
 * The journey forms of the two key sets.
 *
 * Separate rather than permissive: a document scan has no steps, so a rule that set a `stepId` there
 * would emit a field naming something that does not exist. It stays an unknown field on that path.
 */
const JOURNEY_CREATE_FINDING_KEYS = new Set([...CREATE_FINDING_KEYS, "stepId"]);
const JOURNEY_EVIDENCE_KEYS = new Set([...EVIDENCE_KEYS, "stepId"]);
const SOURCE_KEYS = new Set(["file", "startLine", "startColumn", "endLine", "endColumn"]);
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

  const endLine = normalizeOptionalNumberValue(
    readOwnProperty(record, "endLine", `${field}.endLine`, rule),
    `${field}.endLine`,
    rule,
  );
  const endColumn = normalizeOptionalNumberValue(
    readOwnProperty(record, "endColumn", `${field}.endColumn`, rule),
    `${field}.endColumn`,
    rule,
  );

  return Object.freeze({
    ...(file !== undefined ? { file } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(startColumn !== undefined ? { startColumn } : {}),
    // Carried through, each independently optional. An adapter that knows where something ends
    // reports it; one that does not omits it, and a consumer drawing a range is told which it has
    // rather than handed a zero-length range that looks like a measurement.
    ...(endLine !== undefined ? { endLine } : {}),
    ...(endColumn !== undefined ? { endColumn } : {}),
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

function normalizeEvidence(value: unknown, field: string, rule: Rule, journey = false): Evidence {
  const record = assertPlainRecord(
    value,
    field,
    journey ? JOURNEY_EVIDENCE_KEYS : EVIDENCE_KEYS,
    rule,
  );
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
  const stepId = journey
    ? normalizeOptionalStringValue(
        readOwnProperty(record, "stepId", `${field}.stepId`, rule),
        `${field}.stepId`,
        rule,
      )
    : undefined;
  return Object.freeze({
    ...(locator !== undefined ? { locator } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
  });
}

function normalizeEvidenceArray(
  value: unknown,
  field: string,
  rule: Rule,
  journey = false,
): Evidence[] {
  const array = assertDenseArray(value, field, rule);
  const output: Evidence[] = [];
  for (let index = 0; index < array.length; index += 1) {
    output.push(normalizeEvidence(array[index], `${field}[${index}]`, rule, journey));
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

function normalizePositiveInteger(value: unknown, field: string, rule: Rule): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  fail(rule, field, "expected an integer of at least 1", value === ABSENT ? undefined : value);
}

function normalizeTextEdit(value: unknown, field: string, rule: Rule): TextEdit {
  const record = assertPlainRecord(value, field, TEXT_EDIT_KEYS, rule);
  const startLine = normalizePositiveInteger(
    readOwnProperty(record, "startLine", `${field}.startLine`, rule),
    `${field}.startLine`,
    rule,
  );
  const startColumn = normalizePositiveInteger(
    readOwnProperty(record, "startColumn", `${field}.startColumn`, rule),
    `${field}.startColumn`,
    rule,
  );
  const endLine = normalizePositiveInteger(
    readOwnProperty(record, "endLine", `${field}.endLine`, rule),
    `${field}.endLine`,
    rule,
  );
  const endColumn = normalizePositiveInteger(
    readOwnProperty(record, "endColumn", `${field}.endColumn`, rule),
    `${field}.endColumn`,
    rule,
  );
  // A range that ends before it starts is not a small mistake: applied, it either does nothing or
  // deletes in the wrong direction, and neither reports anything.
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) {
    fail(rule, `${field}.endLine`, "range must not end before it starts", endLine);
  }
  const expected = normalizeOptionalStringValue(
    readOwnProperty(record, "expected", `${field}.expected`, rule),
    `${field}.expected`,
    rule,
  );
  if (expected === undefined) {
    // Empty is allowed — an insertion replaces nothing — but absent is not. A range without the text
    // it expects is a bet that nothing moved between the scan and the write, and that bet is lost
    // quietly: the edit lands somewhere plausible and the file is wrong in a way nothing reports.
    fail(rule, `${field}.expected`, "expected a string, including an empty one", undefined);
  }
  const replacement = normalizeOptionalStringValue(
    readOwnProperty(record, "replacement", `${field}.replacement`, rule),
    `${field}.replacement`,
    rule,
  );
  if (replacement === undefined) {
    fail(rule, `${field}.replacement`, "expected a string, including an empty one", undefined);
  }
  return Object.freeze({
    startLine,
    startColumn,
    endLine,
    endColumn,
    expected,
    replacement,
  });
}

function normalizeRemediation(value: unknown, field: string, rule: Rule): Remediation {
  const record = assertPlainRecord(value, field, REMEDIATION_KEYS, rule);
  const origin = normalizeRequiredEnumValue<RemediationOrigin>(
    readOwnProperty(record, "origin", `${field}.origin`, rule),
    `${field}.origin`,
    VALID_REMEDIATION_ORIGIN,
    rule,
  );
  const safety = normalizeRequiredEnumValue<RemediationSafety>(
    readOwnProperty(record, "safety", `${field}.safety`, rule),
    `${field}.safety`,
    VALID_REMEDIATION_SAFETY,
    rule,
  );
  // The boundary, as a validation rule rather than a promise in a document. An AI-suggested edit
  // cannot be `safe`, so nothing downstream has to remember that it must not apply one — and the
  // gate exists before the thing it gates, because a boundary added after the feature is one
  // someone has already worked around.
  if (origin === "ai" && safety === "safe") {
    fail(rule, `${field}.safety`, "an ai-origin remediation must not be safe", safety);
  }
  const fileChecksum = normalizeRequiredStringValue(
    readOwnProperty(record, "fileChecksum", `${field}.fileChecksum`, rule),
    `${field}.fileChecksum`,
    rule,
  );
  if (!SHA256_HEX.test(fileChecksum)) {
    fail(rule, `${field}.fileChecksum`, "expected lowercase hex SHA-256", fileChecksum);
  }
  const rawEdits = readOwnProperty(record, "edits", `${field}.edits`, rule);
  const edits = assertDenseArray(rawEdits, `${field}.edits`, rule).map((edit, index) =>
    normalizeTextEdit(edit, `${field}.edits[${index}]`, rule),
  );
  if (edits.length === 0) {
    fail(rule, `${field}.edits`, "expected at least one edit", undefined);
  }
  return Object.freeze({
    id: normalizeRequiredStringValue(
      readOwnProperty(record, "id", `${field}.id`, rule),
      `${field}.id`,
      rule,
    ),
    origin,
    safety,
    title: normalizeRequiredStringValue(
      readOwnProperty(record, "title", `${field}.title`, rule),
      `${field}.title`,
      rule,
    ),
    description: normalizeRequiredStringValue(
      readOwnProperty(record, "description", `${field}.description`, rule),
      `${field}.description`,
      rule,
    ),
    // Required for both safety levels: a `safe` classification needs an argument more than a
    // cautious one does, and an author who could not write the sentence should not carry the label.
    rationale: normalizeRequiredStringValue(
      readOwnProperty(record, "rationale", `${field}.rationale`, rule),
      `${field}.rationale`,
      rule,
    ),
    file: normalizeRequiredStringValue(
      readOwnProperty(record, "file", `${field}.file`, rule),
      `${field}.file`,
      rule,
    ),
    fileChecksum,
    edits: Object.freeze(edits) as unknown as Remediation["edits"],
  });
}

export function validateCreateFindingInput(
  input: unknown,
  rule: Rule,
  options: { readonly journey?: boolean } = {},
): CreateFindingInput {
  const journey = options.journey === true;
  const record = assertPlainRecord(
    input,
    "createFinding input",
    journey ? JOURNEY_CREATE_FINDING_KEYS : CREATE_FINDING_KEYS,
    rule,
  );
  const evidence = normalizeEvidenceArray(
    readOwnProperty(record, "evidence", "createFinding input.evidence", rule),
    "createFinding input.evidence",
    rule,
    journey,
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
  const rawRemediation = readOwnProperty(
    record,
    "remediation",
    "createFinding input.remediation",
    rule,
  );
  const remediation =
    rawRemediation !== ABSENT && rawRemediation !== undefined
      ? normalizeRemediation(rawRemediation, "createFinding input.remediation", rule)
      : undefined;

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
    ...(remediation !== undefined ? { remediation } : {}),
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
  const category = normalizeRequiredStringValue(
    readOwnProperty(record, "category", `${field}.category`, rule),
    `${field}.category`,
    rule,
  ) as Category;
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
  const rawRemediation = readOwnProperty(record, "remediation", `${field}.remediation`, rule);
  // Re-validated on the way out, not trusted because `createFinding` built it: a rule may return a
  // finding it assembled itself, and this is the only place that sees every one of them.
  const remediation =
    rawRemediation !== ABSENT && rawRemediation !== undefined
      ? normalizeRemediation(rawRemediation, `${field}.remediation`, rule)
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
    ...(remediation !== undefined ? { remediation } : {}),
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
