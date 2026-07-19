import type {
  Evidence,
  FairUxBatchReport,
  FairUxReport,
  Finding,
  NodeLocator,
  RuleMeta,
  Severity,
} from "@fairux/core";
import { fnv1a64 } from "@fairux/core";
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
 * SARIF 2.1.0 reporter — per ADR P4-T1.
 *
 * Severity → level is analyzer-honest (high→error, medium→warning, low|info→note).
 * Teams that disagree re-grade in `fairux.config.ts`, NOT here, so JSON envelope and SARIF
 * stay in sync. Fingerprints emit a versioned key (`fairuxV1`) so a future algorithm change
 * can write both `fairuxV1` and `fairuxV2` for a transition window — downstream baselines stay
 * stable. The FairUX disclaimer lives in `tool.driver.fullDescription` AND in
 * `run.properties.fairux.disclaimer` so SARIF viewers AND raw consumers both see it.
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

  // SARIF requires at least one location per result; if a finding has no usable evidence,
  // fall back to a logical location named after the rule so we never emit an invalid result.
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

  // Build partialFingerprints.primaryLocationLineHash for GitHub code scanning baseline
  // tracking. GitHub's upload-sarif uses this for dedup/line-drift when present; when absent
  // it generates its own. We emit it only for results with a physical location (file + line).
  const primaryEvidence = finding.evidence.find(
    (e) => e.source?.file && e.source?.startLine != null,
  );
  const src = primaryEvidence?.source;
  const partialFingerprints: Record<string, string> | undefined =
    src?.file && src.startLine != null
      ? {
          primaryLocationLineHash: fnv1a64(`${src.file}:${src.startLine}:${finding.ruleId}`),
        }
      : undefined;

  return {
    ruleId: finding.ruleId,
    level: LEVEL_BY_SEVERITY[finding.severity],
    message: { text: finding.description },
    locations,
    ...(relatedLocations.length > 0 ? { relatedLocations } : {}),
    fingerprints: { [FINGERPRINT_KEY]: finding.fingerprint },
    ...(partialFingerprints ? { partialFingerprints } : {}),
    properties,
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
