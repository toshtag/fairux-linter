import { describe, expect, it } from "vitest";
import { dictionary } from "../src/index.js";

describe("KeywordDictionary", () => {
  // Browser-safety complement to scripts/check-runtime-safety.mjs: reusable patterns must be
  // stateless, so no `g`/`y` flags (their lastIndex causes intermittent missed matches).
  it("uses no global or sticky RegExp flags", () => {
    for (const [locale, group] of Object.entries(dictionary)) {
      for (const [name, patterns] of Object.entries(group ?? {})) {
        for (const re of patterns) {
          expect(re.global, `${locale}.${name}: ${re}`).toBe(false);
          expect(re.sticky, `${locale}.${name}: ${re}`).toBe(false);
        }
      }
    }
  });

  it("ships both en and ja groups", () => {
    expect(dictionary.en?.accept?.length).toBeGreaterThan(0);
    expect(dictionary.ja?.accept?.length).toBeGreaterThan(0);
  });
});
