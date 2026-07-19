import { describe, expect, it } from "vitest";
import { auditSourceMap } from "../scripts/source-map-audit.mjs";

describe("SDK source map audit", () => {
  it("rejects embedded sourcesContent", () => {
    const errors = auditSourceMap(
      "dist/index.js.map",
      JSON.stringify({ version: 3, sources: ["../src/index.ts"], sourcesContent: ["secret"] }),
    );

    expect(errors.join("\n")).toContain("sourcesContent");
  });

  it("rejects absolute build host paths", () => {
    const errors = auditSourceMap(
      "dist/index.js.map",
      JSON.stringify({ version: 3, sources: ["/Users/tochi/project/packages/sdk/src/index.ts"] }),
    );

    expect(errors.join("\n")).toContain("absolute path");
  });

  it("rejects internal package source paths", () => {
    const errors = auditSourceMap(
      "dist/index.js.map",
      JSON.stringify({ version: 3, sources: ["../../packages/core/src/index.ts"] }),
    );

    expect(errors.join("\n")).toContain("rejected path");
  });

  it("accepts sanitized relative dist paths", () => {
    const errors = auditSourceMap(
      "dist/index.js.map",
      JSON.stringify({ version: 3, sources: ["index.js"], sourcesContent: [] }),
    );

    expect(errors).toEqual([]);
  });
});
