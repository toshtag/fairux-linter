import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxBatchReport, FairUxReport, JourneyReport, RiskIndexReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_INDEX_MODEL_VERSION } from "../../apps/cli/src/risk-index.js";
import type { RiskIndexModel } from "../../packages/core/src/index.js";
import {
  BUILTIN_CAPABILITY_IDS,
  computeRiskIndex as coreComputeRiskIndex,
} from "../../packages/core/src/index.js";
import rulesManifest from "../../packages/rules/package.json" with { type: "json" };
import { RISK_INDEX_MODELS } from "../../packages/rules/src/index.js";
import { computeRiskIndex as sdkComputeRiskIndex } from "../../packages/sdk/src/index.js";

/** The least a Risk Index will accept, so the SDK's default model is what the call is measuring. */
const emptyReport = {
  kind: "single",
  schemaVersion: "0.1",
  toolVersion: "documentation-contract",
  generatedAt: "2026-01-01T00:00:00.000Z",
  input: { runtime: "html", file: "a.html" },
  summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
  findings: [],
} as unknown as FairUxReport;

/**
 * The rows of the first Markdown table whose header names `column`.
 *
 * Reading a table rather than a sentence: the facts below are per-surface, and a table is where a
 * reader looks for one of three answers. It also means rewording a row leaves the assertion alone,
 * while dropping the surface it describes does not.
 */
function table(doc: string, column: string): string[] {
  const lines = doc.split("\n");
  const header = lines.findIndex((line) => line.startsWith(`| ${column} `));
  if (header < 0) throw new Error(`no table with a "${column}" column`);
  const body = lines.slice(header + 2);
  const end = body.findIndex((line) => !line.startsWith("|"));
  return body.slice(0, end < 0 ? undefined : end);
}

function row(rows: string[], label: string): string {
  const found = rows.find((line) => line.startsWith(`| \`${label}\``));
  if (!found) throw new Error(`no row for ${label} in:\n${rows.join("\n")}`);
  return found;
}

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

  it("names every model that ships", () => {
    // The page said "No model ships yet. Every call today returns unsupported" for as long as two
    // models shipped, because the sentence was true of `@fairux/core` — the one caller a reader of
    // this page is least likely to be. Read from the rule pack, so a third model cannot arrive
    // without this page naming it.
    for (const model of RISK_INDEX_MODELS) {
      expect(SCHEMA_DOC, `report-schema.md must name ${model.version}`).toContain(model.version);
    }
    expect(SCHEMA_DOC).not.toContain("No model ships yet");
  });

  it("gives each surface its own default, read from that surface", () => {
    // Three defaults, three sources — and the SDK's is the one that has to be *run* to be read. It
    // is a fallback inside `computeRiskIndex`, not an exported constant, so asserting it against
    // `@fairux/rules` would have compared the document to a package the SDK is free to stop
    // agreeing with. It happens to agree today; that is what makes the shortcut invisible.
    const surfaces = table(SCHEMA_DOC, "Surface");

    const sdkDefault = sdkComputeRiskIndex(emptyReport, { toolVersion: "documentation-contract" })
      .versions.modelVersion;
    expect(sdkDefault, "the SDK's default must produce a modelVersion to compare").not.toBeNull();
    expect(row(surfaces, "@fairux/sdk")).toContain(sdkDefault);

    expect(row(surfaces, "fairux scan --risk-index")).toContain(DEFAULT_RISK_INDEX_MODEL_VERSION);
    expect(row(surfaces, "@fairux/core")).toContain("no-model");
  });

  it("does not describe modelVersion as a way to choose one", () => {
    // The mistake this replaced. `modelVersion` is a guard — core throws when it disagrees with the
    // model it was handed — and `packages/sdk/test/sdk.test.ts` pins that the SDK call with only a
    // `modelVersion` raises. A page that reads as though naming a version selects it sends a reader
    // to write the one call that cannot work.
    expect(SCHEMA_DOC).toMatch(/`modelVersion` does not select a model/);
    // The SDK reaches v2 by handing over the model, and only the CLI takes the string.
    expect(row(table(SCHEMA_DOC, "Surface"), "@fairux/sdk")).toContain("fairuxRiskIndexModelV2");
    expect(row(table(SCHEMA_DOC, "Surface"), "fairux scan --risk-index")).toContain(
      "--risk-index-model",
    );
  });

  it("says modelVersion identifies the model rather than the outcome", () => {
    // The JSON comment read "null exactly when no model produced a score", which is the one thing
    // `modelVersion` does not track: `packages/core/src/risk-index.ts` fills it from the supplied
    // model before it decides whether that model applies. Verified by running it, so the sentence
    // and the field cannot drift.
    // `satisfies`, not a cast: a fixture cast to `never` proves the runtime behaviour of an object
    // nothing has checked is a model. This one has to be one.
    const notApplicable = {
      version: "documentation-model/1",
      appliesTo: () => false,
      evaluate: () => {
        throw new Error("appliesTo returned false; evaluate must not run");
      },
    } satisfies RiskIndexModel;
    const result = coreComputeRiskIndex(emptyReport, {
      model: notApplicable,
      toolVersion: "documentation-contract",
    });

    expect(result.status).toBe("unsupported");
    expect(result.reason?.code).toBe("model-not-applicable");
    expect(result.score).toBeNull();
    // The whole point: a model that scored nothing is still named.
    expect(result.versions.modelVersion).toBe("documentation-model/1");

    expect(SCHEMA_DOC).toContain("null only when no model was supplied");
    expect(SCHEMA_DOC).not.toContain("null exactly when no model produced a score");
  });

  it("says the same thing in the types a consumer's editor shows them", () => {
    // The reference page was corrected while `RiskIndexVersions` carried the old contract in both
    // packages, and the SDK's copy reaches `dist/*.d.ts` — so the sentence a consumer sees on hover
    // said the opposite of the page they were sent to. Prose in three places, one of which is
    // shipped.
    const coreSource = readFileSync(join(ROOT, "packages/core/src/risk-index.ts"), "utf8");
    const sdkSource = readFileSync(join(ROOT, "packages/sdk/src/public-types.ts"), "utf8");

    for (const [name, source] of Object.entries({ core: coreSource, sdk: sdkSource })) {
      // Anchored on the declaration, because the two packages attach the doc differently: Core
      // documents the interface, the SDK documents the field. Both end up as the last block before
      // it.
      const declaration = source.indexOf("readonly modelVersion: string | null");
      expect(declaration, `${name}: no modelVersion declaration to read`).toBeGreaterThan(0);
      const doc = source.slice(source.lastIndexOf("/**", declaration), declaration);
      expect(doc, `${name}: modelVersion does not track the score`).not.toContain(
        "no model produced a score",
      );
      // The reason code rather than a sentence: `model-not-applicable` is the case the old wording
      // got wrong, and an identifier survives rewording where a phrase does not.
      expect(doc, `${name}: name the unscored path this field outlives`).toContain(
        "model-not-applicable",
      );
    }

    // And the SDK ships two models, so its `RiskIndexModel` must not say none do. `@fairux/core`'s
    // own "None ships here" is scoped to that package and stays.
    // The brace matters: `RiskIndexModelInput` and `RiskIndexModelResult` are both declared above it.
    const modelAt = sdkSource.indexOf("export interface RiskIndexModel {");
    expect(modelAt, "no RiskIndexModel declaration to read").toBeGreaterThan(0);
    const sdkModelDoc = sdkSource.slice(sdkSource.lastIndexOf("/**", modelAt), modelAt);
    expect(sdkModelDoc).not.toMatch(/None ships/);
    expect(sdkModelDoc).toContain("fairuxRiskIndexModelV2");
  });

  it("calls @fairux/rules internal, and names the SDK as the way to reach it", () => {
    // `packages/rules` is `private: true` and `compatibility.md` lists it among the packages that
    // are not public. "The models ship beside the rules, in `@fairux/rules`" was true about where
    // the code lives and read as an install target.
    expect(rulesManifest.private, "@fairux/rules must stay unpublished").toBe(true);
    const riskSection = SCHEMA_DOC.slice(SCHEMA_DOC.indexOf("## Risk Index"));
    for (const idea of [/internal/i, /@fairux\/rules/, /@fairux\/sdk/]) {
      expect(riskSection, `the Risk Index section must say ${idea}`).toMatch(idea);
    }
  });

  it("documents model-not-applicable, which a custom model can still reach", () => {
    // The page briefly said a report from the SDK or the CLI is `sufficient` or
    // `insufficient-coverage`. A custom model whose `appliesTo` rejects the input returns
    // `unsupported` instead, and the SDK takes custom models.
    //
    // This keeps the reason code documented. It does not detect a contradicting sentence somewhere
    // else on the page — no assertion here can, and claiming otherwise in a test name is how the
    // previous version of this one read stronger than it was.
    expect(SCHEMA_DOC).toContain("model-not-applicable");
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
