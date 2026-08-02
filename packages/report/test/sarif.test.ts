import type { FairUxBatchReport } from "@fairux/core";
import { fairuxBuiltinRulePack } from "@fairux/rules";
import { describe, expect, it } from "vitest";
import { DISCLAIMER, toBatchSarif, toSarif, toSarifObject } from "../src/index.js";
import {
  externalCategoryReport,
  sampleCoverage,
  sampleReport,
  sampleReportWithCoverage,
} from "./_fixture.js";

const run = (sample = sampleReport) => toSarifObject(sample).runs[0];
const ensure = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
};

describe("toSarif / toSarifObject", () => {
  it("emits a well-formed SARIF 2.1.0 envelope (round-trips through JSON)", () => {
    const text = toSarif(sampleReport);
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.$schema).toContain("sarif-2.1.0");
    expect(parsed.runs).toHaveLength(1);
  });

  it("places the disclaimer in tool.driver.fullDescription AND run.properties.fairux.disclaimer", () => {
    const r = ensure(run(), "run");
    expect(r.tool.driver.fullDescription?.text).toBe(DISCLAIMER);
    const fairuxProps = (r.properties as { fairux?: { disclaimer?: string } } | undefined)?.fairux;
    expect(fairuxProps?.disclaimer).toBe(DISCLAIMER);
  });

  it("carries rule-pack provenance in run properties when present", () => {
    const r = ensure(
      run({ ...sampleReport, rulePacks: [{ id: "@fairux/builtin", version: "0.1.0" }] }),
      "run",
    );
    const fairuxProps = (r.properties as { fairux?: { rulePacks?: unknown[] } } | undefined)
      ?.fairux;
    expect(fairuxProps?.rulePacks).toEqual([{ id: "@fairux/builtin", version: "0.1.0" }]);
  });

  it("maps severity to SARIF level analyzer-honestly (high→error, medium→warning, low→note)", () => {
    const r = ensure(run(), "run");
    // Fixture has high(F1), medium(F2), low(F3) in order
    expect(r.results[0]?.level).toBe("error");
    expect(r.results[1]?.level).toBe("warning");
    expect(r.results[2]?.level).toBe("note");
  });

  it("emits the FairUX fingerprint under the versioned key fairuxV1", () => {
    const r = ensure(run(), "run");
    expect(r.results[0]?.fingerprints.fairuxV1).toBe("1111111111111111");
    expect(r.results[1]?.fingerprints.fairuxV1).toBe("2222222222222222");
    expect(r.results[2]?.fingerprints.fairuxV1).toBe("3333333333333333");
  });

  it("uses physicalLocation when evidence has source.file (HTML adapter)", () => {
    const r = ensure(run(), "run");
    // F1: locator css + source file/line → physical wins
    const f1 = ensure(r.results[0]?.locations[0]?.physicalLocation, "F1 physical");
    expect(f1.artifactLocation.uri).toBe("checkout.html");
    expect(f1.region).toEqual({ startLine: 12 });
  });

  it("URI-encodes SARIF artifact paths without collapsing literal backslashes", () => {
    const finding = ensure(sampleReport.findings[0], "finding");
    const report = {
      ...sampleReport,
      findings: [
        {
          ...finding,
          evidence: [
            {
              ...ensure(finding.evidence[0], "evidence"),
              source: {
                file: "src/component\\legacy#checkout?.tsx",
                startLine: 12,
              },
            },
          ],
        },
        ...sampleReport.findings.slice(1),
      ],
    };

    const r = ensure(run(report), "run");
    const physical = ensure(r.results[0]?.locations[0]?.physicalLocation, "physical location");
    expect(physical.artifactLocation.uri).toBe("src/component%5Clegacy%23checkout%3F.tsx");
  });

  it("uses logicalLocations when evidence has only a locator (DOM/Figma runtimes)", () => {
    const r = ensure(run(), "run");
    // F2: locator css only, no source → logical
    const f2 = ensure(r.results[1]?.locations[0]?.logicalLocations?.[0], "F2 logical");
    expect(f2.name).toBe("#newsletter");
    expect(f2.kind).toBe("css");
    expect(f2.fullyQualifiedName).toBe("css:#newsletter");
  });

  /**
   * A result carrying only `logicalLocations` fails the *entire* SARIF submission to GitHub code
   * scanning — `locationFromSarifResult: expected a physical location` — so one Figma or DOM
   * finding used to mean nothing uploaded at all, including the source-located findings beside it.
   * Dropping `locations` fails the same way. Measured by the SARIF upload canary; the record is in
   * `docs/maintainers/sarif-canary.md` and the defect was
   * [#90](https://github.com/toshtag/fairux-linter/issues/90).
   */
  describe("a locator-only finding is anchored to the file that was scanned", () => {
    it("carries the physical and the logical part in the same location", () => {
      const r = ensure(run(), "run");
      const location = ensure(r.results[1]?.locations[0], "F2 location");
      expect(location.physicalLocation?.artifactLocation.uri).toBe("checkout.html");
      // Nothing is given up: SARIF allows a location to be both, so a FairUX-aware consumer still
      // reads the locator it always read.
      expect(location.logicalLocations?.[0]?.fullyQualifiedName).toBe("css:#newsletter");
    });

    it("names the file and nothing narrower", () => {
      // No `region`. A Figma node and a live DOM element have no line, and inventing one is the
      // dishonesty this reporter exists to avoid — GitHub displays such a result at line 1 itself.
      const r = ensure(run(), "run");
      expect(r.results[1]?.locations[0]?.physicalLocation?.region).toBeUndefined();
    });

    it("stays logical-only when the scan had no file at all", () => {
      // Live DOM input. There is no file to name, so nothing is added — and such a report still
      // cannot be uploaded to code scanning, which is a property of the input, not of the reporter.
      const r = ensure(
        run({ ...sampleReport, input: { ...sampleReport.input, file: undefined } }),
        "run",
      );
      const location = ensure(r.results[1]?.locations[0], "F2 location");
      expect(location.physicalLocation).toBeUndefined();
      expect(location.logicalLocations?.[0]?.fullyQualifiedName).toBe("css:#newsletter");
    });

    it("leaves a source-located finding exactly as it was", () => {
      // The anchor is a fallback, not a rewrite: a finding that already knows its line keeps it.
      const r = ensure(run(), "run");
      const physical = ensure(r.results[0]?.locations[0]?.physicalLocation, "F1 physical");
      expect(physical.region?.startLine).toBeDefined();
      expect(r.results[0]?.locations[0]?.logicalLocations).toBeUndefined();
    });
  });

  it("carries FairUX-specific signal in result.properties.fairux (confidence, category, etc.)", () => {
    const r = ensure(run(), "run");
    const result = ensure(r.results[0], "result");
    const fairux = (result.properties as { fairux: Record<string, unknown> }).fairux;
    expect(fairux.confidence).toBe("medium");
    expect(fairux.category).toBe("subscription");
    expect(fairux.recommendation).toContain("billing-start");
    expect((fairux.references as string[])[0]).toContain("ftc.gov");
  });

  it("preserves external category ids", () => {
    const r = ensure(run(externalCategoryReport), "run");
    const fairux = (r.results[0]?.properties as { fairux: Record<string, unknown> } | undefined)
      ?.fairux;
    expect(fairux?.category).toBe("purchase-guard/return-policy");
  });

  it("populates rules[] from findings when no registry is provided (id-only fallback)", () => {
    const r = ensure(run(), "run");
    const ids = r.tool.driver.rules?.map((rule) => rule.id) ?? [];
    expect(ids).toEqual([
      "consent/checked-checkbox",
      "scarcity/scarcity-phrase",
      "subscription/free-trial-without-renewal-disclosure",
    ]);
    expect(r.tool.driver.rules?.[0]?.name).toBeUndefined(); // id-only fallback
  });

  it("populates rules[] richly when a RuleMeta registry is provided", () => {
    const log = toSarifObject(sampleReport, {
      rules: [
        {
          id: "subscription/free-trial-without-renewal-disclosure",
          title: "Free trial CTA lacks renewal disclosure",
          category: "subscription",
          defaultSeverity: "high",
          defaultConfidence: "medium",
          defaultEnabled: true,
          tags: ["subscription", "free-trial"],
          version: "1.0.0",
          maturity: "stable",
          requiredCapabilities: ["structure", "text"],
          evidenceRequirements: ["presence"],
          references: ["https://www.ftc.gov/business-guidance/blog"],
        },
      ],
    });
    const rule = ensure(log.runs[0]?.tool.driver.rules?.[0], "rule");
    expect(rule.name).toBe("Free trial CTA lacks renewal disclosure");
    expect(rule.helpUri).toContain("ftc.gov");
    expect((rule.properties as { category: string }).category).toBe("subscription");
    const fairux = (rule.properties as { fairux: Record<string, unknown> }).fairux;
    expect(fairux.maturity).toBe("stable");
    expect(fairux.requiredCapabilities).toEqual(["structure", "text"]);
    expect(fairux.evidenceRequirements).toEqual(["presence"]);
  });

  it("populates SARIF rules[] from actual built-in RuleMeta governance", () => {
    const log = toSarifObject(sampleReport, {
      rules: fairuxBuiltinRulePack.rules.map((rule) => rule.meta),
    });
    const rules = log.runs[0]?.tool.driver.rules ?? [];
    expect(rules).toHaveLength(13);

    const checkedCheckbox = ensure(
      rules.find((rule) => rule.id === "consent/checked-checkbox"),
      "checked checkbox rule",
    );
    const fairux = (checkedCheckbox.properties as { fairux: Record<string, unknown> }).fairux;
    expect(fairux.maturity).toBe("stable");
    expect(fairux.jurisdictions).toEqual(["EEA", "EU", "US"]);
    expect(fairux.officialSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "us/ftc-dark-patterns-report" }),
        expect.objectContaining({ id: "eu/edpb-guidelines-05-2020-consent" }),
      ]),
    );
    expect(fairux.knownLimitations).toEqual([
      "A checked attribute may not match runtime state after scripts execute.",
    ]);

    const visualImbalance = ensure(
      rules.find((rule) => rule.id === "consent/accept-reject-visual-imbalance"),
      "accept/reject visual imbalance rule",
    );
    expect(visualImbalance.helpUri).toBeUndefined();
    expect((visualImbalance.properties as { experimental: boolean }).experimental).toBe(true);
    const visualFairux = (visualImbalance.properties as { fairux: Record<string, unknown> }).fairux;
    expect(visualFairux.maturity).toBe("experimental");
    expect(visualFairux.requiredCapabilities).toEqual(["structure", "text", "style-hints"]);
    expect(visualFairux.optionalCapabilities).toEqual(["computed-style"]);
    expect(visualFairux.evidenceRequirements).toEqual(["comparison", "text-match"]);
    expect(visualFairux.jurisdictions).toEqual(["EEA", "EU", "GB", "US"]);
  });

  it("does not emit generic helpUri links for actual built-in SARIF rules", () => {
    const log = toSarifObject(sampleReport, {
      rules: fairuxBuiltinRulePack.rules.map((rule) => rule.meta),
    });
    const rules = log.runs[0]?.tool.driver.rules ?? [];
    expect(rules).toHaveLength(13);
    expect(rules.every((rule) => rule.helpUri === undefined)).toBe(true);
  });

  it("does not emit vacated or proposed governance sources into SARIF", () => {
    const log = toSarifObject(sampleReport, {
      rules: fairuxBuiltinRulePack.rules.map((rule) => rule.meta),
    });
    const encoded = JSON.stringify(log);
    expect(encoded).not.toContain("us/ftc-negative-option-2024-vacated-final-rule");
    expect(encoded).not.toContain("us/ftc-negative-option-2026-anprm");
  });

  it("does not emit partialFingerprints", () => {
    const r = ensure(run(), "run");
    // F1 and F3 have physical source locations; F2 is logical-only. FairUX emits no
    // partialFingerprints for any result. upload-sarif may populate primaryLocationLineHash later
    // when its source-resolution requirements are satisfied.
    for (const result of r.results) {
      expect(result.partialFingerprints).toBeUndefined();
    }
    // FairUX-owned identity survives the removal.
    expect(r.results[0]?.fingerprints.fairuxV1).toBe("1111111111111111");
    expect(r.results[1]?.fingerprints.fairuxV1).toBe("2222222222222222");
    expect(r.results[2]?.fingerprints.fairuxV1).toBe("3333333333333333");
  });

  it("matches the SARIF snapshot (contract guard)", () => {
    expect(toSarif(sampleReport)).toMatchSnapshot();
  });
});

describe("toBatchSarif", () => {
  it("preserves SARIF contract for each input run", () => {
    const physicalFinding = ensure(sampleReport.findings[0], "physical finding");
    const figmaFinding = ensure(sampleReport.findings[1], "figma finding");
    const text = toBatchSarif({
      kind: "batch",
      schemaVersion: "0.1",
      toolVersion: sampleReport.toolVersion,
      generatedAt: sampleReport.generatedAt,
      inputs: [
        { file: "checkout.html", runtime: "html" },
        { file: "design.figjson", runtime: "figma" },
      ],
      rulePacks: [{ id: "@fairux/builtin", version: "0.1.0" }],
      summary: {
        total: 2,
        bySeverity: { info: 0, low: 0, medium: 1, high: 1 },
      },
      reports: [
        {
          input: { file: "checkout.html", runtime: "html" },
          summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 0, high: 1 } },
          findings: [physicalFinding],
        },
        {
          input: { file: "design.figjson", runtime: "figma" },
          summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 1, high: 0 } },
          findings: [
            {
              ...figmaFinding,
              evidence: [{ locator: { type: "figma", nodeId: "1:2" }, text: "Email me offers" }],
            },
          ],
        },
      ],
    });
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.$schema).toContain("sarif-2.1.0");
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.runs[0].invocations[0].executionSuccessful).toBe(true);
    expect(parsed.runs[0].tool.driver.fullDescription.text).toBe(DISCLAIMER);
    expect(parsed.runs[0].results[0].fingerprints.fairuxV1).toBe("1111111111111111");
    expect(parsed.runs[0].results[0].partialFingerprints).toBeUndefined();
    expect(parsed.runs[1].results[0].partialFingerprints).toBeUndefined();
    expect(parsed.runs[1].results[0].locations[0].logicalLocations[0]).toMatchObject({
      kind: "figma",
      fullyQualifiedName: "figma:1:2",
    });
    expect(parsed.runs[0].tool.driver.rules[0]).toHaveProperty("id");
    expect(parsed.runs[0].properties.fairux.rulePacks).toEqual([
      { id: "@fairux/builtin", version: "0.1.0" },
    ]);
  });
});

describe("coverage in SARIF", () => {
  it("travels as run property-bag data, beside the disclaimer", () => {
    const log = toSarifObject(sampleReportWithCoverage);
    const properties = log.runs[0]?.properties as { fairux: Record<string, unknown> };
    expect(properties.fairux.coverage).toEqual(sampleCoverage);
    expect(properties.fairux.disclaimer).toBe(DISCLAIMER);
  });

  it("changes no result, location, or fingerprint", () => {
    const withCoverage = toSarifObject(sampleReportWithCoverage);
    const without = toSarifObject(sampleReport);
    expect(withCoverage.runs[0]?.results).toEqual(without.runs[0]?.results);
    expect(withCoverage.runs[0]?.tool).toEqual(without.runs[0]?.tool);
  });

  it("raises no notification: a skipped rule is not an execution problem to report per run", () => {
    const log = toSarifObject(sampleReportWithCoverage);
    const invocation = log.runs[0]?.invocations?.[0] as Record<string, unknown> | undefined;
    expect(invocation?.toolExecutionNotifications).toBeUndefined();
    expect(invocation?.toolConfigurationNotifications).toBeUndefined();
    expect(log.runs[0]?.invocations?.[0]?.executionSuccessful).toBe(true);
  });

  it("is absent, not empty, for a report that carries no coverage", () => {
    const properties = toSarifObject(sampleReport).runs[0]?.properties as {
      fairux: Record<string, unknown>;
    };
    expect("coverage" in properties.fairux).toBe(false);
  });

  it("keeps coverage per run in a batch, matching one run per input", () => {
    const batch: FairUxBatchReport = {
      kind: "batch",
      schemaVersion: "0.1",
      toolVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputs: [
        { file: "a.html", runtime: "html" },
        { file: "b.figma.json", runtime: "figma" },
      ],
      summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
      reports: [
        {
          input: { file: "a.html", runtime: "html" },
          summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
          coverage: sampleCoverage,
          findings: [],
        },
        {
          input: { file: "b.figma.json", runtime: "figma" },
          summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
          findings: [],
        },
      ],
    };
    const log = JSON.parse(toBatchSarif(batch)) as {
      runs: { properties: { fairux: Record<string, unknown> } }[];
    };
    expect(log.runs[0]?.properties.fairux.coverage).toEqual(sampleCoverage);
    expect("coverage" in (log.runs[1]?.properties.fairux ?? {})).toBe(false);
  });
});
