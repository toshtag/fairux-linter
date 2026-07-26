import { describe, expect, it } from "vitest";
import generatedRuleCatalog from "../../../docs/generated/rule-catalog.json" with { type: "json" };
import { isBuiltinJurisdictionId, isSemver } from "../../core/src/index.js";
import reviewRecordsFixture from "../reviews/built-in-rule-reviews.json" with { type: "json" };
import {
  collectRuntimeRuleMetadata,
  validateCorpusReferences,
  validateReviewFoundation,
} from "../scripts/review-validation.mjs";
import { reviewedGovernanceByRuleId } from "../src/generated/reviewed-governance.js";

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
type RuntimeGovernanceFixture = {
  readonly officialSources?: readonly RuntimeSourceFixture[];
};
type RuntimeSourceFixture = {
  readonly id: string;
  readonly [key: string]: unknown;
};
const reviewContracts = { isBuiltinJurisdictionId, isSemver };

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
            supportKind: "direct",
            sourceLocator:
              "Bringing Dark Patterns to Light, Introduction p. 1, pre-checked boxes example.",
            mappingNote:
              "The FTC staff report connects preselected controls to distorted consumer choice; FairUX uses it to review checked consent controls without making a compliance verdict.",
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
    ...reviewContracts,
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

function firstOfficialSourceReview(records = validReviewRecords()): MutableFixture {
  return firstFixture(sourceReviewsOf(firstRuleOf(records)));
}

function reviewRecord(ruleId: string): MutableFixture {
  const record = (reviewRecordsFixture.rules as MutableFixture[]).find(
    (rule) => rule.ruleId === ruleId,
  );
  if (record === undefined) throw new Error(`missing review record ${ruleId}`);
  return record;
}

function officialSourceReview(ruleId: string, sourceId: string): MutableFixture {
  const entry = (reviewRecord(ruleId).officialSourceReviews as MutableFixture[]).find(
    (source) => source.sourceId === sourceId,
  );
  if (entry === undefined) throw new Error(`missing source review ${ruleId}:${sourceId}`);
  return entry;
}

function generatedCatalogRule(ruleId: string): MutableFixture {
  const rule = (generatedRuleCatalog.rules as MutableFixture[]).find(
    (entry) => (entry.identity as MutableFixture).id === ruleId,
  );
  if (rule === undefined) throw new Error(`missing generated catalog rule ${ruleId}`);
  return rule;
}

describe("review foundation validation", () => {
  it("accepts a prepared v2 review record with canonical global jurisdiction", () => {
    const records = validReviewRecords();
    const rule = firstRuleOf(records);
    rule.ruleJurisdictions = ["US", "global"];
    firstFixture(sourceReviewsOf(rule)).jurisdictions = ["US", "global"];

    expect(validateWith({ reviewRecords: records }).ok).toBe(true);
  });

  it("accepts core jurisdiction and SemVer contracts used by runtime governance", () => {
    const records = validReviewRecords();
    const rule = firstRuleOf(records);
    rule.ruleVersion = "1.0.0-beta.1+build.2";
    rule.ruleJurisdictions = ["EEA", "EU", "GB", "US", "global"];
    firstFixture(sourceReviewsOf(rule)).jurisdictions = ["GB", "US"];

    const runtimeRules = collectRuntimeRuleMetadata([
      {
        meta: {
          ...runtimeRule.meta,
          version: "1.0.0-beta.1+build.2",
        },
      },
    ]);

    expect(validateWith({ reviewRecords: records, runtimeRules }).ok).toBe(true);
  });

  it("rejects non-canonical jurisdiction spellings", () => {
    for (const jurisdiction of ["GLOBAL", "UK", "ZZ", "XK", "purchase-guard/private"]) {
      const records = validReviewRecords();
      firstRuleOf(records).ruleJurisdictions = [jurisdiction];

      const result = validateWith({ reviewRecords: records });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain(`non-canonical jurisdiction ${jurisdiction}`);
    }
  });

  it("rejects SemVer strings that core runtime rejects", () => {
    for (const version of ["01.0.0", "1.0.0-01"]) {
      const records = validReviewRecords();
      firstRuleOf(records).ruleVersion = version;

      const result = validateWith({ reviewRecords: records });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("must be strict SemVer");
    }
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

  it("rejects non-current sources without a status note", () => {
    for (const publicationStatus of ["historical", "proposed", "vacated"]) {
      const catalog = validSourceCatalog();
      catalogMetadataOf(firstFixture(sourcesOf(catalog))).publicationStatus = publicationStatus;

      const result = validateWith({ sourceCatalog: catalog });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("statusNote");
    }
  });

  it("accepts current sources without a status note", () => {
    const catalog = validSourceCatalog();
    delete catalogMetadataOf(firstFixture(sourcesOf(catalog))).statusNote;

    expect(validateWith({ sourceCatalog: catalog }).ok).toBe(true);
  });

  it("rejects duplicate official source mappings", () => {
    const records = validReviewRecords();
    const sourceReviews = sourceReviewsOf(firstRuleOf(records));
    sourceReviews.push(clone(firstFixture(sourceReviews)));

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("duplicate official source review");
  });

  it("rejects duplicate source-specific mapping notes within a rule", () => {
    const catalog = validSourceCatalog();
    const sources = sourcesOf(catalog);
    sources.push({
      ...clone(firstFixture(sources)),
      id: "us/ftc-dark-patterns-report-sibling",
      identity: {
        ...clone(identityOf(firstFixture(sources))),
        url: "https://www.ftc.gov/reports/bringing-dark-patterns-light-sibling",
      },
    });
    const records = validReviewRecords();
    const sourceReviews = sourceReviewsOf(firstRuleOf(records));
    sourceReviews.push({
      ...clone(firstFixture(sourceReviews)),
      sourceId: "us/ftc-dark-patterns-report-sibling",
    });

    const result = validateWith({ sourceCatalog: catalog, reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("duplicate source-specific mappingNote");
  });

  it("rejects publication status and support kind mismatches", () => {
    const cases = [
      { publicationStatus: "vacated", supportKind: "direct", message: "must be historical" },
      { publicationStatus: "proposed", supportKind: "direct", message: "must be proposed" },
      {
        publicationStatus: "current",
        supportKind: "historical",
        message: "must not be historical",
      },
      { publicationStatus: "current", supportKind: "proposed", message: "must not be proposed" },
    ];

    for (const item of cases) {
      const catalog = validSourceCatalog();
      const metadata = catalogMetadataOf(firstFixture(sourcesOf(catalog)));
      metadata.publicationStatus = item.publicationStatus;
      if (item.publicationStatus !== "current") {
        metadata.statusNote = "Non-current source retained only for provenance testing.";
      }
      const records = validReviewRecords();
      firstOfficialSourceReview(records).supportKind = item.supportKind;

      const result = validateWith({ sourceCatalog: catalog, reviewRecords: records });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain(item.message);
    }
  });

  it("accepts historical and proposed support kinds only for matching non-current sources", () => {
    const cases = [
      { publicationStatus: "vacated", supportKind: "historical" },
      { publicationStatus: "proposed", supportKind: "proposed" },
    ];

    for (const item of cases) {
      const catalog = validSourceCatalog();
      const metadata = catalogMetadataOf(firstFixture(sourcesOf(catalog)));
      metadata.publicationStatus = item.publicationStatus;
      metadata.statusNote = "Non-current source retained only for provenance testing.";
      const records = validReviewRecords();
      firstOfficialSourceReview(records).supportKind = item.supportKind;

      expect(validateWith({ sourceCatalog: catalog, reviewRecords: records }).ok).toBe(true);
    }
  });

  it("requires standard sources and standard support kind to match", () => {
    const standardCatalog = validSourceCatalog();
    catalogMetadataOf(firstFixture(sourcesOf(standardCatalog))).sourceType = "standard";

    const contextual = validateWith({ sourceCatalog: standardCatalog });

    const standardRecords = validReviewRecords();
    firstOfficialSourceReview(standardRecords).supportKind = "standard";
    const standard = validateWith({
      sourceCatalog: standardCatalog,
      reviewRecords: standardRecords,
    });

    const nonStandardRecords = validReviewRecords();
    firstOfficialSourceReview(nonStandardRecords).supportKind = "standard";
    const nonStandard = validateWith({ reviewRecords: nonStandardRecords });

    expect(contextual.ok).toBe(false);
    expect(contextual.errors.join("\n")).toContain("must be standard for standard sources");
    expect(standard.ok).toBe(true);
    expect(nonStandard.ok).toBe(false);
    expect(nonStandard.errors.join("\n")).toContain("must only be standard");
  });

  it("rejects template mapping notes and generic source locators", () => {
    const templateRecords = validReviewRecords();
    firstOfficialSourceReview(templateRecords).mappingNote =
      "us/ftc-dark-patterns-report reviewed for consent/prechecked-marketing: preselected controls.";

    const genericRecords = validReviewRecords();
    firstOfficialSourceReview(genericRecords).sourceLocator =
      "FTC staff report sections on preselection, obstruction, hidden charges, scarcity, and hard-to-cancel subscriptions.";

    const specificRecords = validReviewRecords();
    firstOfficialSourceReview(specificRecords).sourceLocator =
      "Bringing Dark Patterns to Light, Section I p. 4 countdown timer examples.";

    const template = validateWith({ reviewRecords: templateRecords });
    const generic = validateWith({ reviewRecords: genericRecords });
    const specific = validateWith({ reviewRecords: specificRecords });

    expect(template.ok).toBe(false);
    expect(template.errors.join("\n")).toContain("must be substantive");
    expect(generic.ok).toBe(false);
    expect(generic.errors.join("\n")).toContain("must cite a specific section");
    expect(specific.ok).toBe(true);
  });

  it("keeps current Part 425 mappings contextual for subscription and cancellation rules", () => {
    const part425Rules = new Map(
      (reviewRecordsFixture.rules as MutableFixture[]).map((rule) => [
        rule.ruleId,
        (rule.officialSourceReviews as MutableFixture[]).find(
          (entry) => entry.sourceId === "us/ftc-negative-option-1973-current-rule",
        ),
      ]),
    );

    expect(part425Rules.get("cancellation/missing-cancellation-link")?.supportKind).toBe(
      "contextual",
    );
    expect(part425Rules.get("subscription/cta-without-cancellation-context")?.supportKind).toBe(
      "contextual",
    );
    expect(
      part425Rules.get("subscription/free-trial-without-renewal-disclosure")?.supportKind,
    ).toBe("contextual");
  });

  it("keeps EDPB consent review jurisdictions aligned with EU and EEA scope", () => {
    for (const ruleId of [
      "consent/accept-reject-visual-imbalance",
      "consent/bundled-consent",
      "consent/checked-checkbox",
      "consent/missing-reject-option",
    ]) {
      expect(reviewRecord(ruleId).ruleJurisdictions).toContain("EEA");
      expect(
        officialSourceReview(ruleId, "eu/edpb-guidelines-05-2020-consent").jurisdictions,
      ).toEqual(["EEA", "EU"]);
    }
  });

  it("keeps visual imbalance source support scoped to what each source directly supports", () => {
    const edpb = officialSourceReview(
      "consent/accept-reject-visual-imbalance",
      "eu/edpb-guidelines-05-2020-consent",
    );
    const ico = officialSourceReview(
      "consent/accept-reject-visual-imbalance",
      "uk/ico-storage-access-consent-practice",
    );
    const ftc = officialSourceReview(
      "consent/accept-reject-visual-imbalance",
      "us/ftc-dark-patterns-report",
    );

    expect(edpb.supportKind).toBe("contextual");
    expect(edpb.mappingNote).toContain("does not directly prescribe button color");
    expect(ico.supportKind).toBe("direct");
    expect(ftc.supportKind).toBe("contextual");
    expect(ftc.sourceLocator).toContain("Section IV printed pp. 15-16");
    expect(ftc.sourceLocator).toContain("Appendix A p. 25");
  });

  it("keeps FTC consent locators pinned to concrete consent UI examples", () => {
    expect(
      officialSourceReview("consent/checked-checkbox", "us/ftc-dark-patterns-report").sourceLocator,
    ).toContain("Appendix A printed pp. 24-25");
    expect(
      officialSourceReview("consent/missing-reject-option", "us/ftc-dark-patterns-report")
        .sourceLocator,
    ).toContain("Section IV printed pp. 15-16");
  });

  it("projects only current supported official sources into runtime governance", () => {
    const reviewedRuleIds = (reviewRecordsFixture.rules as MutableFixture[]).map(
      (rule) => rule.ruleId,
    );
    expect(Object.keys(reviewedGovernanceByRuleId).sort()).toEqual(reviewedRuleIds.sort());

    const runtimeGovernance = Object.values(
      reviewedGovernanceByRuleId,
    ) as readonly RuntimeGovernanceFixture[];
    const runtimeSourceIds = runtimeGovernance.flatMap((rule) =>
      (rule.officialSources ?? []).map((source) => source.id),
    );
    expect(runtimeSourceIds).not.toContain("us/ftc-negative-option-2024-vacated-final-rule");
    expect(runtimeSourceIds).not.toContain("us/ftc-negative-option-2026-anprm");

    for (const source of runtimeGovernance.flatMap((rule) => rule.officialSources ?? [])) {
      expect(Object.keys(source).sort()).toEqual([
        "id",
        "jurisdictions",
        "publisher",
        "reviewedAt",
        "title",
        "url",
      ]);
    }
  });

  it("keeps non-current negative-option records in generated catalog provenance only", () => {
    const sourceIds = (generatedRuleCatalog.sources as MutableFixture[]).map((source) => source.id);
    expect(sourceIds).toContain("us/ftc-negative-option-2024-vacated-final-rule");
    expect(sourceIds).toContain("us/ftc-negative-option-2026-anprm");

    const cancellationRule = generatedCatalogRule("cancellation/missing-cancellation-link");
    expect(
      ((cancellationRule.runtimeOfficialSources as MutableFixture[]) ?? []).map(
        (source) => source.id,
      ),
    ).not.toContain("us/ftc-negative-option-2024-vacated-final-rule");
    expect(
      (cancellationRule.officialSourceReviewProvenance as MutableFixture[]).map(
        (entry) => (entry.source as MutableFixture).id,
      ),
    ).toEqual([
      "us/ftc-dark-patterns-report",
      "us/ftc-negative-option-1973-current-rule",
      "us/ftc-negative-option-2024-vacated-final-rule",
      "us/ftc-negative-option-2026-anprm",
    ]);
  });

  it("keeps scarcity and negative-option review prose source-specific", () => {
    for (const ruleId of ["scarcity/countdown-timer", "scarcity/scarcity-phrase"]) {
      const limitations = officialSourceReview(ruleId, "eu/ucpd-annex-limited-time-claims")
        .limitations as string;

      expect(limitations).not.toContain("Consent source");
      expect(limitations).toContain("false limited-time or limited-availability claims");
      expect(limitations).toContain("cannot determine whether");
    }
    expect(
      officialSourceReview(
        "cancellation/missing-cancellation-link",
        "us/ftc-negative-option-2024-vacated-final-rule",
      ).mappingNote,
    ).not.toContain("negative-option a missing");
  });

  it("rejects leading and trailing whitespace in review strings", () => {
    const records = validReviewRecords();
    firstFixture(sourceReviewsOf(firstRuleOf(records))).mappingNote =
      " Supports preselected consent control review.";

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("must not contain leading or trailing whitespace");
  });

  it("rejects exact-schema review exception violations", () => {
    const records = validReviewRecords();
    firstRuleOf(records).reviewExceptions = [
      {
        id: "pending-source-review",
        scope: "source",
        status: "open",
        owner: "maintainers",
        reason: "Needs explicit review.",
        resolutionCriteria: "Record maintainer approval.",
        approvedBy: "maintainer",
      },
    ];

    const result = validateWith({ reviewRecords: records });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("contains unknown field approvedBy");
    expect(result.errors.join("\n")).toContain("open exception must not contain approval fields");
  });

  it("accepts strict maintainer-approved review exception schema", () => {
    const records = validReviewRecords();
    firstRuleOf(records).reviewExceptions = [
      {
        id: "approved-corpus-exception",
        scope: "corpus",
        status: "maintainer-approved",
        owner: "maintainers",
        reason: "Fixture cannot represent provider account state.",
        resolutionCriteria: "Explicit maintainer review accepts the gap.",
        approvedBy: "maintainer",
        approvedAt: "2026-07-22",
      },
    ];

    expect(validateWith({ reviewRecords: records }).ok).toBe(true);
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
