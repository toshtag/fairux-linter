import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxBatchReport, FairUxReport, JourneyReport, RiskIndexReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_CAPABILITY_IDS } from "../../packages/core/src/index.js";
import { fairuxRiskIndexModel, RISK_INDEX_MODELS } from "../../packages/rules/src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_DOC = readFileSync(join(ROOT, "docs/reference/report-schema.md"), "utf8");
const COMPATIBILITY = readFileSync(join(ROOT, "docs/reference/compatibility.md"), "utf8");

/**
 * A field disappearing from a report is the breaking change a consumer notices last and cares about
 * most: their code compiles, their parser runs, and the value they read is `undefined`.
 *
 * Asserted through the type system rather than by reading the schema document. A test that parsed
 * the prose would be checking that two documents agree; this checks that the document describes the
 * type a consumer actually receives, which is the direction that matters.
 */
type Assert<T extends true> = T;
type HasKeys<T, K extends keyof T> = [K] extends [keyof T] ? true : false;

type _Report = Assert<
  HasKeys<
    FairUxReport,
    | "kind"
    | "schemaVersion"
    | "toolVersion"
    | "generatedAt"
    | "input"
    | "rulePacks"
    | "summary"
    | "coverage"
    | "findings"
    | "suppressed"
    | "suppressionDiagnostics"
    | "aiAugmentation"
  >
>;
type _Batch = Assert<
  HasKeys<
    FairUxBatchReport,
    "kind" | "schemaVersion" | "toolVersion" | "generatedAt" | "inputs" | "summary" | "reports"
  >
>;
type _Journey = Assert<
  HasKeys<
    JourneyReport,
    | "kind"
    | "schemaVersion"
    | "toolVersion"
    | "generatedAt"
    | "steps"
    | "findings"
    | "summary"
    | "stepSummary"
    | "coverage"
  >
>;
type _RiskIndex = Assert<
  HasKeys<
    RiskIndexReport,
    | "kind"
    | "versions"
    | "generatedAt"
    | "status"
    | "score"
    | "confidence"
    | "coverage"
    | "contributingFindings"
    | "limitations"
  >
>;

describe("the documented report fields", () => {
  it("compiles only while every one of them exists on the type", () => {
    // The assertions above are the test. This case exists so a failure names itself.
    expect(true).toBe(true);
  });

  it("keeps schemaVersion at the value every consumer has pinned on", () => {
    // It has not moved through coverage, journeys, remediations, the Risk Index, or AI augmentation,
    // because every one of those was a new optional field. Moving it invalidates every stored report.
    const report: FairUxReport["schemaVersion"] = "0.1";
    expect(report).toBe("0.1");
    expect(SCHEMA_DOC).toContain('"schemaVersion": "0.1"');
  });

  it("keeps the Risk Index's own version separate from the report's", () => {
    const riskIndex: RiskIndexReport["versions"]["schemaVersion"] = "0.1";
    expect(riskIndex).toBe("0.1");
    // Separate on purpose: a change to what a score means must not invalidate a findings report.
    expect(COMPATIBILITY).toContain("Its own `schemaVersion`, independent of the report's");
  });

  it("names the models that ship, and the one the SDK and the CLI default to", () => {
    // The page said "No model ships yet. Every call today returns unsupported" for as long as two
    // models shipped, because the sentence was true of `@fairux/core` — which is the one caller a
    // reader of this page is least likely to be. Read from the rule pack so a third model cannot
    // arrive without this sentence being rewritten.
    for (const model of RISK_INDEX_MODELS) {
      expect(SCHEMA_DOC, `report-schema.md must name ${model.version}`).toContain(model.version);
    }
    expect(SCHEMA_DOC).toContain(`both supply\n\`${fairuxRiskIndexModel.version}\` unless told`);
    // And must not have gone back to claiming there is nothing to name.
    expect(SCHEMA_DOC).not.toContain("No model ships yet");
  });
});

describe("the documented capability vocabulary", () => {
  it("lists every built-in id, in the order every surface reports them", () => {
    // The enumeration is prose a consumer reads to know what a coverage list can contain. A new
    // capability that reached the type and not this line would make the document quietly wrong
    // about what an `unavailable` entry might say.
    const documented = /\*\*`CapabilityId`\*\*: ([\s\S]*?), or a\s+namespaced/.exec(SCHEMA_DOC);
    expect(documented).not.toBeNull();
    const ids = [...(documented?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual([...BUILTIN_CAPABILITY_IDS]);
  });
});

describe("the compatibility document", () => {
  it("names every published entry point, and says the rest are not public", () => {
    for (const specifier of ["@fairux/sdk", "@fairux/sdk/html", "@fairux/sdk/dom"]) {
      expect(COMPATIBILITY).toContain(specifier);
    }
    for (const internal of ["@fairux/core", "@fairux/rules", "@fairux/report"]) {
      expect(COMPATIBILITY).toContain(internal);
    }
    expect(COMPATIBILITY).toContain("**Not public**");
  });

  it("states the deprecation-before-removal rule", () => {
    expect(COMPATIBILITY).toContain("Nothing is removed without being deprecated first");
  });

  it("says which guarantees are checked and which rest on review", () => {
    // A policy claiming to be fully mechanised would be less honest than one that says which half is.
    expect(COMPATIBILITY).toContain("What is checked, and what rests on review");
    expect(COMPATIBILITY).toContain("| Everything else here | review |");
  });

  it("is honest that this is a beta", () => {
    expect(COMPATIBILITY).toContain("not a contract anybody has signed");
  });
});
