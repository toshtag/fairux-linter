import type {
  Evidence,
  FairUxBatchReport,
  FairUxReport,
  Finding,
  NodeLocator,
  RuleMeta,
  ScanCoverage,
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
import { diagnosticLines, hasSuppressionRecord, suppressedLines } from "./suppression-view.js";

/**
 * SARIF 2.1.0 reporter.
 *
 * Severity → level is analyzer-honest (high→error, medium→warning, low|info→note).
 * Teams that disagree re-grade in `fairux.config.ts`, NOT here, so JSON envelope and SARIF
 * stay in sync. Fingerprints emit a versioned key (`fairuxV1`) so a future algorithm change
 * can write both `fairuxV1` and `fairuxV2` for a transition window — downstream baselines stay
 * stable. `fairuxV1` is FairUX-owned identity for FairUX-aware consumers; GitHub code scanning does
 * not use it as its native alert-matching key. `partialFingerprints` is a SARIF-standard property,
 * not a GitHub-owned namespace; GitHub code scanning currently consumes its
 * `primaryLocationLineHash` entry, and this reporter emits no `partialFingerprints` at all — see
 * `findingToResult`. The FairUX disclaimer lives in `tool.driver.fullDescription` AND in
 * `run.properties.fairux.disclaimer` so SARIF viewers AND raw consumers both see it. Coverage travels
 * the same way, in `run.properties.fairux.coverage` — property-bag data a consumer that does not
 * know it will ignore, rather than a notification GitHub would surface on every pull request.
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

/**
 * A location naming the scanned file and nothing narrower.
 *
 * For a finding with no source line — a Figma node, a live DOM element — the file it came from is
 * the most precise thing that is *true*. No `region`: a Figma node has no line, and inventing one
 * would be the dishonesty this reporter exists to avoid.
 */
function inputFileLocation(inputFile: string): SarifPhysicalLocation {
  return { artifactLocation: { uri: toArtifactUri(inputFile) } };
}

/**
 * @param inputFile the file this report scanned, when there is one. Live DOM input has none.
 */
function evidenceToLocation(evidence: Evidence, inputFile?: string): SarifLocation | undefined {
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
    const logicalLocations = [
      {
        name,
        kind: evidence.locator.type,
        fullyQualifiedName: `${evidence.locator.type}:${name}`,
      },
    ];
    // Both, in one location, when the scan had a file. SARIF allows a location to carry a physical
    // and a logical part together, so nothing is given up: FairUX-aware consumers still read the
    // locator, and GitHub code scanning gets the physical anchor it requires.
    //
    // It requires one. A result with only `logicalLocations` fails the *entire* SARIF submission
    // with `locationFromSarifResult: expected a physical location`, so a scan producing a single
    // Figma or DOM finding uploaded nothing at all — including the source-located findings beside
    // it. Dropping `locations` fails the same way (`expected at least one location`). Measured by
    // the SARIF upload canary; see `docs/maintainers/sarif-canary.md`.
    return inputFile
      ? { physicalLocation: inputFileLocation(inputFile), logicalLocations }
      : { logicalLocations };
  }
  return undefined;
}

function findingToResult(finding: Finding, inputFile?: string): SarifResult {
  const [primary, ...rest] = finding.evidence
    .map((evidence) => evidenceToLocation(evidence, inputFile))
    .filter((loc): loc is SarifLocation => loc !== undefined);

  // SARIF permits a locationless result (`result.locations` is SHOULD, not MUST). FairUX emits at
  // least one location anyway, for downstream usability: if a finding has no usable evidence, fall
  // back to a logical location named after the rule rather than inventing a source line — anchored
  // to the scanned file when there is one, for the reason above.
  const ruleFallback: SarifLocation = {
    ...(inputFile ? { physicalLocation: inputFileLocation(inputFile) } : {}),
    logicalLocations: [{ name: finding.ruleId, kind: "rule" }],
  };
  const locations: SarifLocation[] = primary ? [primary] : [ruleFallback];
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

  // No `partialFingerprints` are emitted. `partialFingerprints` is a SARIF-standard property, and
  // GitHub code scanning currently consumes its `primaryLocationLineHash` entry. This reporter
  // receives locations, not source file bytes, so it cannot compute that source-aware value, and
  // any approximation drifts with line moves.
  //
  // Leaving the field absent allows `github/codeql-action/upload-sarif` to attempt to populate it
  // when the primary physical location has a resolvable source file and line number. The Action may
  // still leave it absent when those conditions are not met.
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

/**
 * Coverage as SARIF property-bag data.
 *
 * A property bag, not a result and not a notification. `toolExecutionNotifications` would be the
 * expressive choice and it is also the one that changes what a consumer sees as *output* of the run:
 * GitHub surfaces notifications, and a rule that was skipped because a Figma export has no source
 * lines is not something to raise in a pull request every time. Properties are ignored by consumers
 * that do not know them, which is the correct default for a field this new.
 *
 * Copied verbatim from the envelope rather than re-derived, so SARIF cannot disagree with the JSON
 * report about what ran.
 */
/**
 * What an inline directive removed, and what one failed to remove, under `run.properties.fairux`.
 *
 * A SARIF consumer sees `results`, and a directive removes a finding before it becomes one — so an
 * upload from a page whose consent rule had been turned off on line 4 was indistinguishable from an
 * upload from a page with no directive. Code scanning has its own suppression model and this is
 * deliberately not it: FairUX's directive is applied inside the scanner and leaves no result to
 * suppress, so what is published is the record, under the vendor property bag where every other
 * FairUX-specific fact already lives.
 */
function suppressionProperties(record: {
  readonly suppressed?: FairUxReport["suppressed"];
  readonly suppressionDiagnostics?: FairUxReport["suppressionDiagnostics"];
}): Record<string, unknown> {
  if (!hasSuppressionRecord(record)) return {};
  const suppressed = suppressedLines(record.suppressed);
  const diagnostics = diagnosticLines(record.suppressionDiagnostics);
  return {
    ...(suppressed.length > 0 ? { inlineSuppressions: suppressed } : {}),
    ...(diagnostics.length > 0 ? { suppressionDiagnostics: diagnostics } : {}),
  };
}

function coverageProperties(coverage: ScanCoverage | undefined): Record<string, unknown> {
  return coverage ? { coverage } : {};
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
        results: report.findings.map((finding) => findingToResult(finding, report.input.file)),
        invocations: [{ executionSuccessful: true }],
        properties: {
          fairux: {
            schemaVersion: report.schemaVersion,
            runtime: report.input.runtime,
            generatedAt: report.generatedAt,
            disclaimer: DISCLAIMER,
            ...coverageProperties(report.coverage),
            ...suppressionProperties(report),
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
      results: subReport.findings.map((finding) => findingToResult(finding, input?.file)),
      invocations: [{ executionSuccessful: true }],
      properties: {
        fairux: {
          schemaVersion: report.schemaVersion,
          runtime: input?.runtime || "unknown",
          file: input?.file,
          figmaFile: input?.figmaFile,
          generatedAt: report.generatedAt,
          disclaimer: DISCLAIMER,
          ...coverageProperties(subReport.coverage),
          ...suppressionProperties(subReport),
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
