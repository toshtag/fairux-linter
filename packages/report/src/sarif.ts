import type {
  Evidence,
  FairUxBatchReport,
  FairUxReport,
  Finding,
  NodeLocator,
  RuleMeta,
  Severity,
} from "@fairux/core";
import { DISCLAIMER } from "./disclaimer.js";
import type {
  SarifLevel,
  SarifLocation,
  SarifLog,
  SarifPhysicalLocation,
  SarifReportingDescriptor,
  SarifResult,
} from "./sarif-types.js";

/**
 * SARIF 2.1.0 reporter.
 *
 * Severity → level is analyzer-honest (high→error, medium→warning, low|info→note).
 * Teams that disagree re-grade in `fairux.config.ts`, NOT here, so JSON envelope and SARIF
 * stay in sync. Fingerprints emit a versioned key (`fairuxV1`) so a future algorithm change
 * can write both `fairuxV1` and `fairuxV2` for a transition window — downstream baselines stay
 * stable. `fairuxV1` is FairUX-owned identity for FairUX-aware consumers; it is NOT GitHub's
 * alert-matching key. GitHub matches on `partialFingerprints`, which this reporter deliberately
 * does not emit — see `findingToResult`. The FairUX disclaimer lives in
 * `tool.driver.fullDescription` AND in `run.properties.fairux.disclaimer` so SARIF viewers AND raw
 * consumers both see it.
 */

const SARIF_VERSION = "2.1.0" as const;
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const FAIRUX_INFO_URI = "https://github.com/toshtag/fairux-linter";
const FINGERPRINT_KEY = "fairuxV1";

const LEVEL_BY_SEVERITY: Record<Severity, SarifLevel> = {
  high: "error",
  medium: "warning",
  low: "note",
  info: "note",
};

export interface SarifOptions {
  /**
   * Optional rule registry. When provided, `tool.driver.rules[]` carries full metadata
   * (id, name, helpUri, category, tags). When omitted, rules[] is derived from findings —
   * id-only, no help, no tags.
   */
  rules?: ReadonlyArray<RuleMeta>;
}

function locatorName(locator: NodeLocator): string {
  switch (locator.type) {
    case "css":
      return locator.value;
    case "path":
      return locator.value.join(",");
    case "ast":
      return `${locator.file}:${locator.startLine}:${locator.startColumn}`;
    case "figma":
      return locator.nodeId;
  }
}

function toArtifactUri(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

function evidenceToLocation(evidence: Evidence): SarifLocation | undefined {
  // Physical location is preferred when source has a file. Falls back to logical when only
  // a locator is present — honest about the locator basis (no fake source lines).
  if (evidence.source?.file) {
    const physicalLocation: SarifPhysicalLocation = {
      artifactLocation: { uri: toArtifactUri(evidence.source.file) },
    };
    if (evidence.source.startLine !== undefined) {
      physicalLocation.region =
        evidence.source.startColumn !== undefined
          ? {
              startLine: evidence.source.startLine,
              startColumn: evidence.source.startColumn,
            }
          : { startLine: evidence.source.startLine };
    }
    return { physicalLocation };
  }
  if (evidence.locator) {
    const name = locatorName(evidence.locator);
    return {
      logicalLocations: [
        {
          name,
          kind: evidence.locator.type,
          fullyQualifiedName: `${evidence.locator.type}:${name}`,
        },
      ],
    };
  }
  return undefined;
}

function findingToResult(finding: Finding): SarifResult {
  const [primary, ...rest] = finding.evidence
    .map(evidenceToLocation)
    .filter((loc): loc is SarifLocation => loc !== undefined);

  // SARIF permits a locationless result (`result.locations` is SHOULD, not MUST). FairUX emits at
  // least one location anyway, for downstream usability: if a finding has no usable evidence, fall
  // back to a logical location named after the rule rather than inventing a source line.
  const locations: SarifLocation[] = primary
    ? [primary]
    : [{ logicalLocations: [{ name: finding.ruleId, kind: "rule" }] }];
  const relatedLocations = rest;

  const properties: Record<string, unknown> = {
    fairux: {
      confidence: finding.confidence,
      category: finding.category,
      title: finding.title,
      whyItMatters: finding.whyItMatters,
      recommendation: finding.recommendation,
      ...(finding.references && finding.references.length > 0
        ? { references: finding.references }
        : {}),
    },
  };

  // No `partialFingerprints`. That namespace is GitHub's alert-matching key, and this reporter
  // receives locations, not source file bytes — it cannot reproduce GitHub's source-aware
  // fingerprint, and any approximation drifts with line moves. Leaving the field absent lets
  // `github/codeql-action/upload-sarif` generate the native value from the source files it reads.
  return {
    ruleId: finding.ruleId,
    level: LEVEL_BY_SEVERITY[finding.severity],
    message: { text: finding.description },
    locations,
    ...(relatedLocations.length > 0 ? { relatedLocations } : {}),
    fingerprints: { [FINGERPRINT_KEY]: finding.fingerprint },
    properties,
  };
}

function governanceProperties(meta: RuleMeta): Record<string, unknown> {
  return {
    maturity: meta.maturity,
    requiredCapabilities: meta.requiredCapabilities,
    evidenceRequirements: meta.evidenceRequirements,
    ...(meta.optionalCapabilities && meta.optionalCapabilities.length > 0
      ? { optionalCapabilities: meta.optionalCapabilities }
      : {}),
    ...(meta.jurisdictions && meta.jurisdictions.length > 0
      ? { jurisdictions: meta.jurisdictions }
      : {}),
    ...(meta.officialSources && meta.officialSources.length > 0
      ? { officialSources: meta.officialSources }
      : {}),
    ...(meta.knownLimitations && meta.knownLimitations.length > 0
      ? { knownLimitations: meta.knownLimitations }
      : {}),
    ...(meta.deprecation ? { deprecation: meta.deprecation } : {}),
  };
}

function rulesFromRegistry(rules: ReadonlyArray<RuleMeta>): SarifReportingDescriptor[] {
  return rules.map((meta) => {
    const helpUri = meta.references?.[0];
    return {
      id: meta.id,
      name: meta.title,
      shortDescription: { text: meta.title },
      ...(helpUri ? { helpUri } : {}),
      properties: {
        category: meta.category,
        tags: meta.tags,
        experimental: meta.experimental === true,
        fairux: governanceProperties(meta),
      },
    };
  });
}

function rulesFromFindings(report: FairUxReport): SarifReportingDescriptor[] {
  const ids = Array.from(new Set(report.findings.map((f) => f.ruleId))).sort();
  return ids.map((id) => ({ id }));
}

function rulePackProperties(
  rulePacks: FairUxReport["rulePacks"] | FairUxBatchReport["rulePacks"],
): Record<string, unknown> {
  return rulePacks && rulePacks.length > 0
    ? { rulePacks: rulePacks.map((pack) => ({ id: pack.id, version: pack.version })) }
    : {};
}

export function toSarifObject(report: FairUxReport, options: SarifOptions = {}): SarifLog {
  const rules =
    options.rules && options.rules.length > 0
      ? rulesFromRegistry(options.rules)
      : rulesFromFindings(report);

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "FairUX",
            version: report.toolVersion,
            informationUri: FAIRUX_INFO_URI,
            shortDescription: { text: "Rule-based UX risk-signal linter." },
            fullDescription: { text: DISCLAIMER },
            rules,
          },
        },
        results: report.findings.map(findingToResult),
        invocations: [{ executionSuccessful: true }],
        properties: {
          fairux: {
            schemaVersion: report.schemaVersion,
            runtime: report.input.runtime,
            generatedAt: report.generatedAt,
            disclaimer: DISCLAIMER,
            ...rulePackProperties(report.rulePacks),
          },
        },
      },
    ],
  };
}

/** SARIF 2.1.0 JSON string — public API alongside `toJson` / `toMarkdown`. */
export function toSarif(report: FairUxReport, options: SarifOptions = {}): string {
  return JSON.stringify(toSarifObject(report, options), null, 2);
}

/** SARIF 2.1.0 for batch reports — one run per input to preserve per-file runtime metadata. */
export function toBatchSarif(report: FairUxBatchReport, options: SarifOptions = {}): string {
  const rules =
    options.rules && options.rules.length > 0
      ? rulesFromRegistry(options.rules)
      : Array.from(new Set(report.reports.flatMap((r) => r.findings.map((f) => f.ruleId))))
          .sort()
          .map((id) => ({ id }));

  const runs = report.reports.map((subReport, i) => {
    const input = report.inputs[i];
    return {
      tool: {
        driver: {
          name: "FairUX",
          version: report.toolVersion,
          informationUri: FAIRUX_INFO_URI,
          shortDescription: { text: "Rule-based UX risk-signal linter." },
          fullDescription: { text: DISCLAIMER },
          rules,
        },
      },
      results: subReport.findings.map(findingToResult),
      invocations: [{ executionSuccessful: true }],
      properties: {
        fairux: {
          schemaVersion: report.schemaVersion,
          runtime: input?.runtime || "unknown",
          file: input?.file,
          figmaFile: input?.figmaFile,
          generatedAt: report.generatedAt,
          disclaimer: DISCLAIMER,
          ...rulePackProperties(report.rulePacks),
        },
      },
    };
  });

  return JSON.stringify(
    {
      $schema: SARIF_SCHEMA,
      version: SARIF_VERSION,
      runs,
    },
    null,
    2,
  );
}
