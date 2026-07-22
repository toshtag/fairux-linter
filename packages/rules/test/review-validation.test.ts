import { describe, expect, it } from "vitest";
import {
  collectRuntimeRuleMetadata,
  validateCorpusReferences,
  validateReviewFoundation,
} from "../scripts/review-validation.mjs";

const runtimeRule = {
  meta: {
    id: "consent/prechecked-marketing",
    version: "1.0.0",
    maturity: "stable",
    experimental: false,
    defaultEnabled: true,
  },
};

type MutableFixture = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function firstFixture<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("fixture unexpectedly empty");
  return item;
}

function validSourceCatalog(): MutableFixture {
  return {
    schemaVersion: 2,
    sources: [
      {
        id: "us/ftc-dark-patterns-report",
        identity: {
          title: "Bringing Dark Patterns to Light",
          publisher: "Federal Trade Commission",
          url: "https://www.ftc.gov/reports/bringing-dark-patterns-light",
        },
        catalogMetadata: {
          publisherType: "official-agency",
          sourceType: "staff-report",
          publicationStatus: "current",
          statusCheckedAt: "2026-07-22",
          sourceSummary: "FTC staff report on dark-pattern interface practices.",
        },
      },
    ],
  };
}

function validReviewRecords(): MutableFixture {
  return {
    schemaVersion: 2,
    reviewPolicy: {
      status: "prepared",
      note: "Prepared review records are not maintainer approvals.",
    },
    rules: [
      {
        ruleId: "consent/prechecked-marketing",
        ruleVersion: "1.0.0",
        status: "prepared",
        maturity: "stable",
        preparedBy: "AI agent: claude-code",
        preparedAt: "2026-07-22",
        ruleJurisdictions: ["US"],
        officialSourceReviews: [
          {
            sourceId: "us/ftc-dark-patterns-report",
            reviewedAt: "2026-07-22",
            jurisdictions: ["US"],
            mappingNote: "Supports preselected consent control review.",
            limitations: "Does not determine legal compliance.",
          },
        ],
        corpusEvidence: {
          positive: [
            {
              id: "prechecked-marketing-checkbox",
              locale: "en",
              testRef: "packages/rules/test/consent.test.ts",
              testCase: "flags a pre-checked marketing box (high) on a consent page [en]",
              summary: "Prechecked marketing opt-in is detected.",
            },
          ],
          negative: [
            {
              id: "unchecked-checkbox",
              locale: "en",
              testRef: "packages/rules/test/consent.test.ts",
              testCase: "does not flag an unchecked box [negative]",
              summary: "Unchecked opt-in is not detected.",
            },
          ],
        },
        uncoveredScenarios: [
          {
            id: "ambiguous-legitimate-interest",
            locale: "en",
            summary: "Ambiguous legitimate-interest copy remains untested.",
            owner: "maintainers",
            reason: "Needs a dedicated fixture before it becomes corpus evidence.",
            resolutionCriteria: "Add positive, negative, or ambiguous test coverage.",
          },
        ],
        reviewNotes: {
          locale: {
            en: "English fixture is covered.",
            ja: "Japanese equivalent remains review-only.",
          },
          runtime: "DOM text and control state only.",
          falsePositive: "Could flag intentionally checked account settings.",
          evidenceUsefulness: "Highlights the specific checked control.",
          performance: "Linear in control count.",
          determinism: "Deterministic over parsed DOM.",
          knownLimitations: ["Does not infer prior user consent."],
        },
        reviewExceptions: [],
      },
    ],
  };
}

function validateWith(overrides: {
  sourceCatalog?: unknown;
  reviewRecords?: unknown;
  runtimeRules?: ReturnType<typeof collectRuntimeRuleMetadata>;
  requireApprovedStable?: boolean;
}) {
  return validateReviewFoundation({
    sourceCatalog: overrides.sourceCatalog ?? validSourceCatalog(),
    reviewRecords: overrides.reviewRecords ?? validReviewRecords(),
    runtimeRules: overrides.runtimeRules ?? collectRuntimeRuleMetadata([runtimeRule]),
    rootDir: ".",
    requireApprovedStable: overrides.requireApprovedStable,
  });
}

function sourcesOf(catalog: MutableFixture): MutableFixture[] {
  return catalog.sources as MutableFixture[];
}

function firstRuleOf(records: MutableFixture): MutableFixture {
  return firstFixture(records.rules as MutableFixture[]);
}

function sourceReviewsOf(rule: MutableFixture): MutableFixture[] {
  return rule.officialSourceReviews as MutableFixture[];
}

function evidenceOf(rule: MutableFixture, kind: "positive" | "negative"): MutableFixture[] {
  return (rule.corpusEvidence as MutableFixture)[kind] as MutableFixture[];
}

function identityOf(source: MutableFixture): MutableFixture {
  return source.identity as MutableFixture;
}

function catalogMetadataOf(source: MutableFixture): MutableFixture {
  return source.catalogMetadata as MutableFixture;
}

describe("review foundation validation", () => {
  it("accepts a prepared v2 review record with canonical global jurisdiction", () => {
    const records = validReviewRecords();
    const rule = firstRuleOf(records);
    rule.ruleJurisdictions = ["US", "global"];
    firstFixture(sourceReviewsOf(rule)).jurisdictions = ["US", "global"];

    expect(validateWith({ reviewRecords: records }).ok).toBe(true);
  });

  it("rejects non-canonical jurisdiction spellings", () => {
    const records = validReviewRecords();
    firstRuleOf(records).ruleJurisdictions = ["GLOBAL"];

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("non-canonical jurisdiction GLOBAL");
  });

  it("rejects stale rule versions against runtime metadata", () => {
    const records = validReviewRecords();
    firstRuleOf(records).ruleVersion = "9.9.9";

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("must match runtime version 1.0.0");
  });

  it("rejects unknown review fields", () => {
    const records = validReviewRecords();
    Object.assign(firstRuleOf(records), { sourceIds: ["us/ftc-dark-patterns-report"] });

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("contains unknown field sourceIds");
  });

  it("rejects duplicate source URLs", () => {
    const catalog = validSourceCatalog();
    const sources = sourcesOf(catalog);
    sources.push({
      ...clone(firstFixture(sources)),
      id: "us/ftc-dark-patterns-report-copy",
    });

    const result = validateWith({ sourceCatalog: catalog });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("duplicate source URL");
  });

  it("rejects non-HTTPS and credentialed source URLs", () => {
    const catalog = validSourceCatalog();
    const identity = identityOf(firstFixture(sourcesOf(catalog)));
    identity.url = "https://user:pass@example.com/source";

    const credentialed = validateWith({ sourceCatalog: catalog });

    identity.url = "http://example.com/source";
    const insecure = validateWith({ sourceCatalog: catalog });

    expect(credentialed.ok).toBe(false);
    expect(credentialed.errors.join("\n")).toContain("must not contain credentials");
    expect(insecure.ok).toBe(false);
    expect(insecure.errors.join("\n")).toContain("must use https");
  });

  it("rejects invalid dates", () => {
    const records = validReviewRecords();
    firstRuleOf(records).preparedAt = "2026-02-31";

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("must be a valid calendar date");
  });

  it("rejects corpus evidence without a test reference", () => {
    const records = validReviewRecords();
    delete firstFixture(evidenceOf(firstRuleOf(records), "positive")).testRef;

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("testRef");
  });

  it("rejects corpus evidence that points to a missing test file", () => {
    const records = validReviewRecords();
    firstFixture(evidenceOf(firstRuleOf(records), "positive")).testRef =
      "packages/rules/test/missing.test.ts";

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("file does not exist");
  });

  it("rejects corpus evidence whose test case marker is absent", () => {
    const records = validReviewRecords();
    firstFixture(evidenceOf(firstRuleOf(records), "positive")).testCase = "missing marker";

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("testCase was not found");
  });

  it("rejects vacated sources without a status note", () => {
    const catalog = validSourceCatalog();
    catalogMetadataOf(firstFixture(sourcesOf(catalog))).publicationStatus = "vacated";

    const result = validateWith({ sourceCatalog: catalog });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("statusNote");
  });

  it("rejects duplicate official source mappings", () => {
    const records = validReviewRecords();
    const sourceReviews = sourceReviewsOf(firstRuleOf(records));
    sourceReviews.push(clone(firstFixture(sourceReviews)));

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("duplicate official source review");
  });

  it("rejects stable prepared records when approval is required", () => {
    const result = validateWith({ requireApprovedStable: true });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("must be maintainer-approved");
  });

  it("rejects a missing corpus path in the pure reference checker", () => {
    const records = validReviewRecords();
    const result = validateCorpusReferences(records, {
      readFile() {
        throw new Error("missing");
      },
    });

    expect(result.errors.join("\n")).toContain("file does not exist");
  });
});
