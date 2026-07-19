import { describe, expect, it } from "vitest";
import { toJson } from "../src/index.js";
import { externalCategoryReport, sampleReport } from "./_fixture.js";

describe("toJson", () => {
  it("round-trips the report envelope exactly (public API)", () => {
    expect(JSON.parse(toJson(sampleReport))).toEqual(sampleReport);
  });

  it("pretty-prints by default and compactly on request", () => {
    expect(toJson(sampleReport)).toContain("\n  ");
    expect(toJson(sampleReport, { pretty: false })).not.toContain("\n");
  });

  it("matches the JSON snapshot (contract guard)", () => {
    expect(toJson(sampleReport)).toMatchSnapshot();
  });

  it("preserves external category ids", () => {
    const parsed = JSON.parse(toJson(externalCategoryReport)) as typeof externalCategoryReport;
    expect(parsed.findings[0]?.category).toBe("purchase-guard/return-policy");
  });
});
