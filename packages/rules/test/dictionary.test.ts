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

  /**
   * No unbounded gap between two required tokens.
   *
   * `/プラン.*変更/` matched 「ご利用中のプラン」 and 「パスワードを変更」 sixty characters apart on a
   * Japanese account page. `cancelLink` is consulted to decide whether a cancel path is **absent**, so
   * the spurious match did not produce a wrong finding — it produced silence, on exactly the page the
   * rule exists for (#187).
   *
   * A bounded gap is not a style preference here. `.*` between two tokens says "anywhere on the page",
   * and page text is one normalized line, so it means "these two words both appear" — which is almost
   * never what a pattern author intends.
   */
  it("puts a bound on every gap between required tokens", () => {
    for (const [locale, group] of Object.entries(dictionary)) {
      for (const [name, patterns] of Object.entries(group ?? {})) {
        for (const re of patterns) {
          expect(re.source, `${locale}.${name}: ${re}`).not.toMatch(/\.[*+]/);
          expect(re.source, `${locale}.${name}: ${re}`).not.toMatch(/\.\{\d+,\}/);
        }
      }
    }
  });

  it("ships both en and ja groups", () => {
    expect(dictionary.en?.accept?.length).toBeGreaterThan(0);
    expect(dictionary.ja?.accept?.length).toBeGreaterThan(0);
  });
});
