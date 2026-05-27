import { describe, expect, it } from "vitest";
import { DISCLAIMER, toMarkdown } from "../src/index.js";
import { emptyReport, sampleReport } from "./_fixture.js";

describe("toMarkdown", () => {
  const md = toMarkdown(sampleReport);

  it("includes the legal disclaimer", () => {
    expect(md).toContain(DISCLAIMER);
  });

  it("shows severity, confidence, recommendation and evidence", () => {
    expect(md).toContain("**Severity:** high  **Confidence:** medium");
    expect(md).toContain("**Recommendation:**");
    expect(md).toContain("`#start-trial`");
    expect(md).toContain("(checkout.html:12)");
  });

  it("groups findings high → medium → low", () => {
    expect(md.indexOf("## High")).toBeLessThan(md.indexOf("## Medium"));
    expect(md.indexOf("## Medium")).toBeLessThan(md.indexOf("## Low"));
  });

  it("renders a clean message when there are no findings", () => {
    const out = toMarkdown(emptyReport);
    expect(out).toContain(DISCLAIMER);
    expect(out).toContain("No findings.");
  });

  it("matches the Markdown snapshot", () => {
    expect(md).toMatchSnapshot();
  });
});
