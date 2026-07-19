import { describe, expect, it } from "vitest";
import { DISCLAIMER, toBatchSarif, toSarif, toSarifObject } from "../src/index.js";
import { sampleReport } from "./_fixture.js";

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

  it("carries FairUX-specific signal in result.properties.fairux (confidence, category, etc.)", () => {
    const r = ensure(run(), "run");
    const fairux = (r.results[0]?.properties as { fairux: Record<string, unknown> }).fairux;
    expect(fairux.confidence).toBe("medium");
    expect(fairux.category).toBe("subscription");
    expect(fairux.recommendation).toContain("billing-start");
    expect((fairux.references as string[])[0]).toContain("ftc.gov");
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
          references: ["https://www.ftc.gov/business-guidance/blog"],
        },
      ],
    });
    const rule = ensure(log.runs[0]?.tool.driver.rules?.[0], "rule");
    expect(rule.name).toBe("Free trial CTA lacks renewal disclosure");
    expect(rule.helpUri).toContain("ftc.gov");
    expect((rule.properties as { category: string }).category).toBe("subscription");
  });

  it("emits partialFingerprints.primaryLocationLineHash for results with physical locations", () => {
    const r = ensure(run(), "run");
    // F1 has source file + line → should have partialFingerprints
    expect(r.results[0]?.partialFingerprints?.primaryLocationLineHash).toBeDefined();
    // F2 has no source file → should NOT have partialFingerprints
    expect(r.results[1]?.partialFingerprints).toBeUndefined();
    // F3 has source file + line → should have partialFingerprints
    expect(r.results[2]?.partialFingerprints?.primaryLocationLineHash).toBeDefined();
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
    expect(parsed.runs[0].results[0].partialFingerprints.primaryLocationLineHash).toBeDefined();
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
