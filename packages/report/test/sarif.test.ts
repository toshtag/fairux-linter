import { describe, expect, it } from "vitest";
import { DISCLAIMER, toSarif, toSarifObject } from "../src/index.js";
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

  it("matches the SARIF snapshot (contract guard)", () => {
    expect(toSarif(sampleReport)).toMatchSnapshot();
  });
});
