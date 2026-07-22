import { readFileSync } from "node:fs";
import { join } from "node:path";

const BIDI = /[\u202a-\u202e\u2066-\u2069]/u;
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RULE_ID = /^[a-z]+(?:-[a-z]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EVIDENCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ALLOWED_SOURCE_TYPES = new Set([
  "case-law",
  "guidance",
  "law",
  "policy-report",
  "regulation",
  "rulemaking-record",
  "staff-report",
  "standard",
]);
const ALLOWED_PUBLICATION_STATUSES = new Set(["current", "historical", "proposed", "vacated"]);
const ALLOWED_SUPPORT_KINDS = new Set([
  "direct",
  "contextual",
  "historical",
  "proposed",
  "standard",
]);
const NON_CURRENT_PUBLICATION_STATUSES = new Set(["historical", "proposed", "vacated"]);
const TEMPLATE_MAPPING_NOTE =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)* reviewed for [a-z]+(?:-[a-z]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*:/u;
const GENERIC_SOURCE_LOCATORS = [
  /^FTC staff report sections on /u,
  /^Current 16 CFR Part 425 text for /u,
  /^Vacated 2024 FTC final rule record /u,
  /^FTC 2026 ANPRM questions on /u,
  /^EDPB Guidelines 05\/2020 sections on /u,
  /^ICO storage and access technologies guidance sections on /u,
  /^Planet49 judgment holdings on /u,
  /^Directive 2005\/29\/EC Annex I item on /u,
  /^OECD policy report taxonomy sections on /u,
  /^WAI-ARIA Authoring Practices modal dialog pattern notes on /u,
  /^FTC Unfair or Deceptive Fees FAQ sections on /u,
];
const ALLOWED_REVIEW_EXCEPTION_SCOPES = new Set([
  "corpus",
  "source",
  "jurisdiction",
  "locale",
  "runtime",
  "false-positive",
  "evidence-usefulness",
  "performance",
  "determinism",
  "known-limitation",
]);
const ALLOWED_REVIEW_EXCEPTION_STATUSES = new Set(["open", "maintainer-approved"]);
const REQUIRED_NOTE_FIELDS = [
  "locale",
  "runtime",
  "falsePositive",
  "evidenceUsefulness",
  "performance",
  "determinism",
  "knownLimitations",
];

export function compareCanonicalId(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function collectRuntimeRuleMetadata(rules) {
  return [...rules]
    .map((rule) => ({
      id: rule.meta.id,
      version: rule.meta.version,
      maturity: rule.meta.maturity,
      experimental: rule.meta.experimental === true,
      defaultEnabled: rule.meta.defaultEnabled,
    }))
    .sort((left, right) => compareCanonicalId(left.id, right.id));
}

export function validateSourceCatalog(catalog) {
  const errors = [];
  const sources = new Map();

  exactKeys(catalog, ["schemaVersion", "sources"], "source catalog", errors);
  if (catalog?.schemaVersion !== 2) errors.push("source catalog schemaVersion must be 2");
  if (!Array.isArray(catalog?.sources) || catalog.sources.length === 0) {
    errors.push("source catalog must contain a non-empty sources array");
    return { errors, sources };
  }

  assertSorted(
    catalog.sources.map((source) => source.id),
    "official source ids",
    errors,
  );
  const urls = new Map();
  for (const source of catalog.sources) {
    exactKeys(source, ["id", "identity", "catalogMetadata"], `source ${source.id}`, errors);
    assertId(source.id, SOURCE_ID, `source ${source.id}.id`, errors);
    if (sources.has(source.id)) errors.push(`duplicate source id: ${source.id}`);
    sources.set(source.id, source);

    exactKeys(
      source.identity,
      ["title", "publisher", "url"],
      `source ${source.id}.identity`,
      errors,
    );
    assertString(source.identity?.title, `source ${source.id}.identity.title`, errors);
    assertString(source.identity?.publisher, `source ${source.id}.identity.publisher`, errors);
    assertCanonicalHttpsUrl(source.identity?.url, `source ${source.id}.identity.url`, errors);
    if (urls.has(source.identity?.url)) {
      errors.push(`duplicate source URL: ${source.identity.url}`);
    } else {
      urls.set(source.identity?.url, source.id);
    }

    exactKeys(
      source.catalogMetadata,
      [
        "publisherType",
        "sourceType",
        "publicationStatus",
        "statusCheckedAt",
        "sourceSummary",
        "statusNote",
      ],
      `source ${source.id}.catalogMetadata`,
      errors,
      { optional: ["statusNote"] },
    );
    assertString(
      source.catalogMetadata?.publisherType,
      `source ${source.id}.catalogMetadata.publisherType`,
      errors,
    );
    assertEnum(
      source.catalogMetadata?.sourceType,
      ALLOWED_SOURCE_TYPES,
      `source ${source.id}.catalogMetadata.sourceType`,
      errors,
    );
    assertEnum(
      source.catalogMetadata?.publicationStatus,
      ALLOWED_PUBLICATION_STATUSES,
      `source ${source.id}.catalogMetadata.publicationStatus`,
      errors,
    );
    assertDate(
      source.catalogMetadata?.statusCheckedAt,
      `source ${source.id}.catalogMetadata.statusCheckedAt`,
      errors,
    );
    assertString(
      source.catalogMetadata?.sourceSummary,
      `source ${source.id}.catalogMetadata.sourceSummary`,
      errors,
    );
    if (NON_CURRENT_PUBLICATION_STATUSES.has(source.catalogMetadata?.publicationStatus)) {
      assertString(
        source.catalogMetadata?.statusNote,
        `source ${source.id}.catalogMetadata.statusNote`,
        errors,
      );
    }
    if ("jurisdictions" in source)
      errors.push(`source ${source.id} must not contain jurisdictions`);
    if ("scopeNote" in source) errors.push(`source ${source.id} must not contain scopeNote`);
  }
  assertNoUnsafeStrings(catalog, "source catalog", errors);
  return { errors, sources };
}

export function validateReviewRecords(records, sources, options = {}) {
  const errors = [];
  const sourceMap = sources instanceof Map ? sources : new Map();
  const requireApprovedStable = options.requireApprovedStable === true;
  const contracts = validateContracts(options, errors);

  exactKeys(records, ["schemaVersion", "reviewPolicy", "rules"], "review records", errors);
  if (records?.schemaVersion !== 2) errors.push("review records schemaVersion must be 2");
  exactKeys(records?.reviewPolicy, ["status", "note"], "reviewPolicy", errors);
  if (records?.reviewPolicy?.status !== "prepared") {
    errors.push("reviewPolicy.status must be prepared");
  }
  assertString(records?.reviewPolicy?.note, "reviewPolicy.note", errors);
  if (!Array.isArray(records?.rules) || records.rules.length === 0) {
    errors.push("review records must contain a non-empty rules array");
    return { errors, counts: emptyCounts() };
  }

  assertSorted(
    records.rules.map((rule) => rule.ruleId),
    "review rule ids",
    errors,
  );
  const counts = emptyCounts();
  const seenRuleIds = new Set();
  const seenEvidenceIds = new Set();
  for (const rule of records.rules) {
    validateReviewRecord(rule, {
      errors,
      sourceMap,
      requireApprovedStable,
      contracts,
      seenRuleIds,
      seenEvidenceIds,
      counts,
    });
  }
  assertNoUnsafeStrings(records, "review records", errors);
  return { errors, counts };
}

export function validateRuleMetadataParity(records, runtimeRules) {
  const errors = [];
  const reviewedRules = [...(records?.rules ?? [])]
    .map((rule) => rule.ruleId)
    .sort(compareCanonicalId);
  const runtimeIds = [...runtimeRules].map((rule) => rule.id).sort(compareCanonicalId);
  if (reviewedRules.join("\u0000") !== runtimeIds.join("\u0000")) {
    errors.push("review records must exactly match runtime built-in rule ids");
  }

  const runtimeById = new Map(runtimeRules.map((rule) => [rule.id, rule]));
  for (const rule of records?.rules ?? []) {
    const runtime = runtimeById.get(rule.ruleId);
    if (!runtime) continue;
    if (rule.ruleVersion !== runtime.version) {
      errors.push(
        `review ${rule.ruleId}.ruleVersion must match runtime version ${runtime.version}`,
      );
    }
    if (rule.maturity !== runtime.maturity) {
      errors.push(`review ${rule.ruleId}.maturity must match runtime maturity ${runtime.maturity}`);
    }
    if (runtime.maturity === "experimental" && (!runtime.experimental || runtime.defaultEnabled)) {
      errors.push(
        `experimental runtime rule ${rule.ruleId} must remain experimental and default-off`,
      );
    }
    if (runtime.maturity === "stable" && runtime.experimental) {
      errors.push(`stable runtime rule ${rule.ruleId} must not be experimental`);
    }
  }
  return { errors };
}

export function validateCorpusReferences(records, options = {}) {
  const errors = [];
  const rootDir = options.rootDir ?? process.cwd();
  const readFile = options.readFile;
  for (const rule of records?.rules ?? []) {
    for (const kind of ["positive", "negative", "ambiguous"]) {
      const entries = rule.corpusEvidence?.[kind];
      if (entries === undefined) continue;
      for (const entry of entries) {
        const label = `review ${rule.ruleId}.${kind}.${entry.id}`;
        if (typeof entry.testRef !== "string") {
          errors.push(`${label}.testRef is required`);
          continue;
        }
        if (!entry.testRef.startsWith("packages/rules/test/") || entry.testRef.includes("..")) {
          errors.push(`${label}.testRef must be under packages/rules/test`);
          continue;
        }
        let text;
        try {
          text = readFile ? readFile(entry.testRef) : undefined;
          if (text === undefined) {
            text = readFileSync(join(rootDir, entry.testRef), "utf8");
          }
        } catch {
          errors.push(`${label}.testRef file does not exist: ${entry.testRef}`);
          continue;
        }
        if (typeof entry.testCase !== "string" || !text.includes(entry.testCase)) {
          errors.push(`${label}.testCase was not found in ${entry.testRef}`);
        }
      }
    }
  }
  return { errors };
}

export function validateReviewFoundation(input) {
  const sourceResult = validateSourceCatalog(input.sourceCatalog);
  const reviewResult = validateReviewRecords(input.reviewRecords, sourceResult.sources, {
    requireApprovedStable: input.requireApprovedStable,
    isBuiltinJurisdictionId: input.isBuiltinJurisdictionId,
    isSemver: input.isSemver,
  });
  const parityResult = validateRuleMetadataParity(input.reviewRecords, input.runtimeRules);
  const corpusResult = validateCorpusReferences(input.reviewRecords, { rootDir: input.rootDir });
  const errors = [
    ...sourceResult.errors,
    ...reviewResult.errors,
    ...parityResult.errors,
    ...corpusResult.errors,
  ];
  const counts = reviewResult.counts;
  return {
    ok: errors.length === 0,
    errors,
    summary: {
      ok: errors.length === 0,
      sourceIdentityCount: sourceResult.sources.size,
      reviewRecordCount: input.reviewRecords?.rules?.length ?? 0,
      stableRuleCount: counts.stable,
      experimentalRuleCount: counts.experimental,
      preparedReviewCount: counts.prepared,
      maintainerApprovedReviewCount: counts.approved,
      uncoveredScenarioCount: counts.uncoveredScenarios,
      requireApprovedStable: input.requireApprovedStable === true,
    },
  };
}

function validateReviewRecord(rule, context) {
  const { errors, sourceMap, requireApprovedStable, seenRuleIds, seenEvidenceIds, counts } =
    context;
  const { contracts } = context;
  const baseKeys = [
    "ruleId",
    "ruleVersion",
    "status",
    "maturity",
    "preparedBy",
    "preparedAt",
    "ruleJurisdictions",
    "officialSourceReviews",
    "corpusEvidence",
    "uncoveredScenarios",
    "reviewNotes",
    "reviewExceptions",
  ];
  const optionalApprovalKeys =
    rule.status === "maintainer-approved" ? ["approvedBy", "approvedAt"] : [];
  exactKeys(rule, [...baseKeys, ...optionalApprovalKeys], `review ${rule.ruleId}`, errors);
  assertId(rule.ruleId, RULE_ID, `review ${rule.ruleId}.ruleId`, errors);
  if (seenRuleIds.has(rule.ruleId)) errors.push(`duplicate review record: ${rule.ruleId}`);
  seenRuleIds.add(rule.ruleId);
  assertSemVer(rule.ruleVersion, `review ${rule.ruleId}.ruleVersion`, errors, contracts);
  assertDate(rule.preparedAt, `review ${rule.ruleId}.preparedAt`, errors);
  assertString(rule.preparedBy, `review ${rule.ruleId}.preparedBy`, errors);

  if (rule.status === "prepared") counts.prepared += 1;
  else if (rule.status === "maintainer-approved") counts.approved += 1;
  else errors.push(`review ${rule.ruleId}.status must be prepared or maintainer-approved`);
  if (rule.status === "prepared" && ("approvedBy" in rule || "approvedAt" in rule)) {
    errors.push(`prepared review ${rule.ruleId} must not contain approval fields`);
  }
  if (rule.status === "maintainer-approved") {
    assertString(rule.approvedBy, `review ${rule.ruleId}.approvedBy`, errors);
    assertDate(rule.approvedAt, `review ${rule.ruleId}.approvedAt`, errors);
  }
  if (
    requireApprovedStable &&
    rule.maturity === "stable" &&
    rule.status !== "maintainer-approved"
  ) {
    errors.push(`stable review ${rule.ruleId} must be maintainer-approved`);
  }

  if (rule.maturity === "stable") counts.stable += 1;
  else if (rule.maturity === "experimental") counts.experimental += 1;
  else errors.push(`review ${rule.ruleId}.maturity must be stable or experimental`);

  validateJurisdictions(
    rule.ruleJurisdictions,
    `review ${rule.ruleId}.ruleJurisdictions`,
    errors,
    contracts,
  );
  validateOfficialSourceReviews(rule, sourceMap, errors, contracts);
  validateCorpusEvidence(rule, seenEvidenceIds, errors);
  validateUncoveredScenarios(rule, errors);
  counts.uncoveredScenarios += rule.uncoveredScenarios?.length ?? 0;
  validateReviewNotes(rule, errors);
  validateReviewExceptions(rule, errors, { requireApprovedStable });
}

function validateOfficialSourceReviews(rule, sourceMap, errors, contracts) {
  if (!Array.isArray(rule.officialSourceReviews) || rule.officialSourceReviews.length === 0) {
    errors.push(`review ${rule.ruleId}.officialSourceReviews must be a non-empty array`);
    return;
  }
  assertSorted(
    rule.officialSourceReviews.map((entry) => entry.sourceId),
    `review ${rule.ruleId}.officialSourceReviews`,
    errors,
  );
  const seen = new Set();
  const mappingNotes = new Set();
  for (const entry of rule.officialSourceReviews) {
    exactKeys(
      entry,
      [
        "sourceId",
        "reviewedAt",
        "jurisdictions",
        "supportKind",
        "sourceLocator",
        "mappingNote",
        "limitations",
      ],
      `review ${rule.ruleId}.officialSourceReviews.${entry.sourceId}`,
      errors,
    );
    assertId(
      entry.sourceId,
      SOURCE_ID,
      `review ${rule.ruleId}.officialSourceReviews.sourceId`,
      errors,
    );
    if (seen.has(entry.sourceId)) {
      errors.push(`duplicate official source review ${rule.ruleId}:${entry.sourceId}`);
    }
    seen.add(entry.sourceId);
    if (!sourceMap.has(entry.sourceId)) {
      errors.push(`review ${rule.ruleId} references unknown source ${entry.sourceId}`);
    }
    const source = sourceMap.get(entry.sourceId);
    assertDate(entry.reviewedAt, `review ${rule.ruleId}.${entry.sourceId}.reviewedAt`, errors);
    validateJurisdictions(
      entry.jurisdictions,
      `review ${rule.ruleId}.${entry.sourceId}.jurisdictions`,
      errors,
      contracts,
    );
    assertEnum(
      entry.supportKind,
      ALLOWED_SUPPORT_KINDS,
      `review ${rule.ruleId}.${entry.sourceId}.supportKind`,
      errors,
    );
    assertString(
      entry.sourceLocator,
      `review ${rule.ruleId}.${entry.sourceId}.sourceLocator`,
      errors,
    );
    assertSpecificSourceLocator(
      entry.sourceLocator,
      `review ${rule.ruleId}.${entry.sourceId}.sourceLocator`,
      errors,
    );
    assertString(entry.mappingNote, `review ${rule.ruleId}.${entry.sourceId}.mappingNote`, errors);
    assertNonTemplateMappingNote(
      entry.mappingNote,
      `review ${rule.ruleId}.${entry.sourceId}.mappingNote`,
      errors,
    );
    if (typeof entry.mappingNote === "string") {
      if (mappingNotes.has(entry.mappingNote)) {
        errors.push(`duplicate source-specific mappingNote in review ${rule.ruleId}`);
      }
      mappingNotes.add(entry.mappingNote);
    }
    assertString(entry.limitations, `review ${rule.ruleId}.${entry.sourceId}.limitations`, errors);
    if (source) validateSourceSupportSemantics(rule, entry, source, errors);
  }
}

function validateSourceSupportSemantics(rule, entry, source, errors) {
  const publicationStatus = source.catalogMetadata?.publicationStatus;
  const sourceType = source.catalogMetadata?.sourceType;
  const label = `review ${rule.ruleId}.${entry.sourceId}`;
  if (
    (publicationStatus === "vacated" || publicationStatus === "historical") &&
    entry.supportKind !== "historical"
  ) {
    errors.push(`${label}.supportKind must be historical for ${publicationStatus} sources`);
  }
  if (publicationStatus === "proposed" && entry.supportKind !== "proposed") {
    errors.push(`${label}.supportKind must be proposed for proposed sources`);
  }
  if (
    publicationStatus === "current" &&
    (entry.supportKind === "historical" || entry.supportKind === "proposed")
  ) {
    errors.push(`${label}.supportKind must not be ${entry.supportKind} for current sources`);
  }
  if (sourceType === "standard" && entry.supportKind !== "standard") {
    errors.push(`${label}.supportKind must be standard for standard sources`);
  }
  if (sourceType !== "standard" && entry.supportKind === "standard") {
    errors.push(`${label}.supportKind must only be standard for standard sources`);
  }
}

function assertSpecificSourceLocator(value, label, errors) {
  if (typeof value !== "string") return;
  if (GENERIC_SOURCE_LOCATORS.some((pattern) => pattern.test(value))) {
    errors.push(
      `${label} must cite a specific section, heading, paragraph, page, FAQ, or standard subsection`,
    );
  }
}

function assertNonTemplateMappingNote(value, label, errors) {
  if (typeof value !== "string") return;
  if (TEMPLATE_MAPPING_NOTE.test(value)) {
    errors.push(`${label} must be substantive, not a source-id reviewed-for template`);
  }
}

function validateCorpusEvidence(rule, seenEvidenceIds, errors) {
  exactKeys(
    rule.corpusEvidence,
    ["positive", "negative", "ambiguous"],
    `review ${rule.ruleId}.corpusEvidence`,
    errors,
    { optional: ["ambiguous"] },
  );
  for (const kind of ["positive", "negative"]) {
    if (!Array.isArray(rule.corpusEvidence?.[kind]) || rule.corpusEvidence[kind].length === 0) {
      errors.push(`review ${rule.ruleId}.corpusEvidence.${kind} must be a non-empty array`);
    }
  }
  for (const kind of ["positive", "negative", "ambiguous"]) {
    const entries = rule.corpusEvidence?.[kind] ?? [];
    if (!Array.isArray(entries)) {
      errors.push(`review ${rule.ruleId}.corpusEvidence.${kind} must be an array`);
      continue;
    }
    for (const entry of entries) {
      exactKeys(
        entry,
        ["id", "locale", "testRef", "testCase", "summary"],
        `review ${rule.ruleId}.${kind}.${entry.id}`,
        errors,
      );
      assertId(entry.id, EVIDENCE_ID, `review ${rule.ruleId}.${kind}.id`, errors);
      const evidenceKey = `${rule.ruleId}:${entry.id}`;
      if (seenEvidenceIds.has(evidenceKey)) {
        errors.push(`duplicate evidence id: ${evidenceKey}`);
      }
      seenEvidenceIds.add(evidenceKey);
      assertLocale(entry.locale, `review ${rule.ruleId}.${kind}.${entry.id}.locale`, errors);
      assertString(entry.testRef, `review ${rule.ruleId}.${kind}.${entry.id}.testRef`, errors);
      assertString(entry.testCase, `review ${rule.ruleId}.${kind}.${entry.id}.testCase`, errors);
      assertString(entry.summary, `review ${rule.ruleId}.${kind}.${entry.id}.summary`, errors);
    }
  }
}

function validateUncoveredScenarios(rule, errors) {
  if (!Array.isArray(rule.uncoveredScenarios)) {
    errors.push(`review ${rule.ruleId}.uncoveredScenarios must be an array`);
    return;
  }
  const seen = new Set();
  for (const scenario of rule.uncoveredScenarios) {
    exactKeys(
      scenario,
      ["id", "locale", "summary", "owner", "reason", "resolutionCriteria"],
      `review ${rule.ruleId}.uncoveredScenarios.${scenario.id}`,
      errors,
    );
    assertId(scenario.id, EVIDENCE_ID, `review ${rule.ruleId}.uncoveredScenarios.id`, errors);
    if (seen.has(scenario.id))
      errors.push(`duplicate uncovered scenario ${rule.ruleId}:${scenario.id}`);
    seen.add(scenario.id);
    assertLocale(scenario.locale, `review ${rule.ruleId}.${scenario.id}.locale`, errors);
    for (const field of ["summary", "owner", "reason", "resolutionCriteria"]) {
      assertString(scenario[field], `review ${rule.ruleId}.${scenario.id}.${field}`, errors);
    }
  }
}

function validateReviewNotes(rule, errors) {
  exactKeys(rule.reviewNotes, REQUIRED_NOTE_FIELDS, `review ${rule.ruleId}.reviewNotes`, errors);
  exactKeys(
    rule.reviewNotes?.locale,
    ["en", "ja"],
    `review ${rule.ruleId}.reviewNotes.locale`,
    errors,
  );
  assertString(rule.reviewNotes?.locale?.en, `review ${rule.ruleId}.reviewNotes.locale.en`, errors);
  assertString(rule.reviewNotes?.locale?.ja, `review ${rule.ruleId}.reviewNotes.locale.ja`, errors);
  for (const field of REQUIRED_NOTE_FIELDS.filter(
    (field) => field !== "locale" && field !== "knownLimitations",
  )) {
    assertString(rule.reviewNotes?.[field], `review ${rule.ruleId}.reviewNotes.${field}`, errors);
  }
  assertStringArray(
    rule.reviewNotes?.knownLimitations,
    `review ${rule.ruleId}.reviewNotes.knownLimitations`,
    errors,
  );
}

function validateReviewExceptions(rule, errors, options) {
  if (!Array.isArray(rule.reviewExceptions)) {
    errors.push(`review ${rule.ruleId}.reviewExceptions must be an array`);
    return;
  }
  const seen = new Set();
  for (const exception of rule.reviewExceptions) {
    const label = `review ${rule.ruleId}.reviewExceptions.${exception?.id}`;
    const optionalApprovalKeys =
      exception?.status === "maintainer-approved" ? ["approvedBy", "approvedAt"] : [];
    exactKeys(
      exception,
      ["id", "scope", "status", "owner", "reason", "resolutionCriteria", ...optionalApprovalKeys],
      label,
      errors,
    );
    assertId(exception?.id, EVIDENCE_ID, `${label}.id`, errors);
    if (seen.has(exception?.id))
      errors.push(`duplicate review exception ${rule.ruleId}:${exception.id}`);
    seen.add(exception?.id);
    assertEnum(exception?.scope, ALLOWED_REVIEW_EXCEPTION_SCOPES, `${label}.scope`, errors);
    assertEnum(exception?.status, ALLOWED_REVIEW_EXCEPTION_STATUSES, `${label}.status`, errors);
    for (const field of ["owner", "reason", "resolutionCriteria"]) {
      assertString(exception?.[field], `${label}.${field}`, errors);
    }
    if (exception?.status === "open" && ("approvedBy" in exception || "approvedAt" in exception)) {
      errors.push(`${label} open exception must not contain approval fields`);
    }
    if (exception?.status === "maintainer-approved") {
      assertString(exception.approvedBy, `${label}.approvedBy`, errors);
      assertDate(exception.approvedAt, `${label}.approvedAt`, errors);
    }
    if (
      options.requireApprovedStable &&
      rule.maturity === "stable" &&
      exception?.status === "open"
    ) {
      errors.push(`stable review ${rule.ruleId} has open review exception ${exception.id}`);
    }
  }
}

function exactKeys(value, allowed, label, errors, options = {}) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const optional = new Set(options.optional ?? []);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
  for (const key of allowed) {
    if (!optional.has(key) && !(key in value))
      errors.push(`${label} missing required field ${key}`);
  }
}

function assertSorted(ids, label, errors) {
  const sorted = [...ids].sort(compareCanonicalId);
  if (ids.join("\u0000") !== sorted.join("\u0000")) {
    errors.push(`${label} must be sorted by canonical id`);
  }
}

function assertId(value, pattern, label, errors) {
  assertString(value, label, errors);
  if (typeof value === "string" && !pattern.test(value)) errors.push(`${label} is not canonical`);
}

function assertString(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (value.trim() !== value)
    errors.push(`${label} must not contain leading or trailing whitespace`);
}

function assertStringArray(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  for (const item of value) assertString(item, `${label}[]`, errors);
}

function assertEnum(value, allowed, label, errors) {
  assertString(value, label, errors);
  if (typeof value === "string" && !allowed.has(value)) errors.push(`${label} is not recognized`);
}

function assertDate(value, label, errors) {
  assertString(value, label, errors);
  if (typeof value !== "string" || !DATE.test(value)) {
    errors.push(`${label} must be YYYY-MM-DD`);
    return;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    errors.push(`${label} must be a valid calendar date`);
  }
}

function assertSemVer(value, label, errors, contracts) {
  assertString(value, label, errors);
  if (typeof value === "string" && !contracts.isSemver(value))
    errors.push(`${label} must be strict SemVer`);
}

function assertLocale(value, label, errors) {
  assertString(value, label, errors);
  if (typeof value === "string" && !/^(en|ja)$/u.test(value))
    errors.push(`${label} must be en or ja`);
}

function assertCanonicalHttpsUrl(value, label, errors) {
  assertString(value, label, errors);
  if (typeof value !== "string") return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${label} must be a valid URL`);
    return;
  }
  if (parsed.protocol !== "https:") errors.push(`${label} must use https`);
  if (parsed.username || parsed.password) errors.push(`${label} must not contain credentials`);
  if (parsed.hash) errors.push(`${label} must not contain a fragment`);
  if (parsed.href !== value) errors.push(`${label} must be canonical URL serialization`);
}

function validateJurisdictions(value, label, errors, contracts) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  assertSorted(value, label, errors);
  const seen = new Set();
  for (const jurisdiction of value) {
    assertString(jurisdiction, `${label}[]`, errors);
    if (seen.has(jurisdiction)) errors.push(`${label} contains duplicate ${jurisdiction}`);
    seen.add(jurisdiction);
    if (typeof jurisdiction !== "string" || !contracts.isBuiltinJurisdictionId(jurisdiction)) {
      errors.push(`${label} contains non-canonical jurisdiction ${jurisdiction}`);
    }
  }
}

function assertNoUnsafeStrings(value, label, errors) {
  if (typeof value === "string") {
    if (containsControlOrBidi(value)) errors.push(`${label} contains control or bidi characters`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoUnsafeStrings(item, `${label}[${index}]`, errors);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (containsControlOrBidi(key)) errors.push(`${label} contains unsafe key characters`);
      assertNoUnsafeStrings(item, `${label}.${key}`, errors);
    }
  }
}

function containsControlOrBidi(value) {
  if (BIDI.test(value)) return true;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f
    ) {
      return true;
    }
  }
  return false;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyCounts() {
  return {
    stable: 0,
    experimental: 0,
    prepared: 0,
    approved: 0,
    uncoveredScenarios: 0,
  };
}

function validateContracts(options, errors) {
  const isBuiltinJurisdictionId = options.isBuiltinJurisdictionId;
  const isSemver = options.isSemver;
  if (typeof isBuiltinJurisdictionId !== "function") {
    errors.push("review validation requires core isBuiltinJurisdictionId contract");
  }
  if (typeof isSemver !== "function") {
    errors.push("review validation requires core isSemver contract");
  }
  return {
    isBuiltinJurisdictionId:
      typeof isBuiltinJurisdictionId === "function" ? isBuiltinJurisdictionId : () => false,
    isSemver: typeof isSemver === "function" ? isSemver : () => false,
  };
}
