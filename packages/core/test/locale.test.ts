import { describe, expect, it } from "vitest";
import { isLocaleTag } from "../src/locale.js";

describe("RFC 5646 locale syntax", () => {
  it("accepts well-formed language tags", () => {
    for (const locale of [
      "en",
      "ja-JP",
      "zh-Hant-TW",
      "de-CH-1901",
      "sl-rozaj-biske-1994",
      "en-u-ca-gregory",
      "de-CH-x-phonebk",
      "x-private",
      "i-klingon",
      "en-a-foo-x-a-bar",
    ]) {
      expect(isLocaleTag(locale)).toBe(true);
    }
  });

  it("rejects malformed language tags", () => {
    for (const locale of [
      "english_us",
      "en--US",
      "en-u",
      "en-x",
      "-x-private",
      "x",
      "de-1901-1901",
      "sl-rozaj-rozaj",
      "sl-rozaj-ROZAJ",
      "en-a-foo-a-bar",
    ]) {
      expect(isLocaleTag(locale)).toBe(false);
    }
  });
});
