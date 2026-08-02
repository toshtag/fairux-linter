import { describe, expect, it } from "vitest";
import { allRules } from "../src/index.js";
import { findingsFor, ruleIds, run } from "./_util.js";

const RULE = "obstruction/confirmshaming";

describe("obstruction/confirmshaming", () => {
  it("flags a guilt-tripping decline button [en]", () => {
    const report = run(
      `<html><body><div class="modal"><p>Get 20% off!</p>
        <button>Subscribe</button>
        <button>No, I don't want to save money</button></div></body></html>`,
      allRules,
    );
    const hits = findingsFor(report, RULE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("medium");
  });

  it("flags a 'I prefer to pay full price' link [en]", () => {
    const report = run(
      `<html><body><a href="#">I prefer to pay full price</a></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("flags a Japanese confirmshaming decline [ja]", () => {
    const report = run(
      `<html lang="ja"><body><div class="modal"><p>20%オフ！</p>
        <button>登録する</button>
        <button>いいえ、お得な情報はいりません</button></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it.each([
    "No, I don't need newsletters",
    "No, I do not want more email",
    "No, I prefer to read on the site",
  ])("does not flag the ordinary decline %s [negative]", (label) => {
    // Each of these fired until 1.1.0. The pattern read `No, I` plus a negation and never looked at
    // what was being declined — which is a refusal, not a guilt trip.
    const report = run(
      `<html><body><div class="modal"><button>Subscribe</button>
        <button>${label}</button></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(0);
  });

  it.each(["いいえ、ニュースレターには興味はありません", "いいえ、今回は必要ありません"])(
    "does not flag the ordinary Japanese decline %s [negative]",
    (label) => {
      // The same defect in the other locale, and worse: `.*` stood between the opening and the
      // refusal, so anything at all could be the thing being declined.
      const report = run(
        `<html lang="ja"><body><div class="modal"><button>購読する</button>
        <button>${label}</button></div></body></html>`,
        allRules,
      );
      expect(findingsFor(report, RULE)).toHaveLength(0);
    },
  );

  it("still flags a Japanese decline that gives up the benefit [ja]", () => {
    const report = run(
      `<html lang="ja"><body><div class="modal"><p>20%オフ！</p>
        <button>登録する</button>
        <button>いいえ、割引は必要ありません</button></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("does not flag a neutral decline label [negative]", () => {
    const report = run(
      `<html><body><div class="modal"><button>Subscribe</button>
        <button>No thanks</button></div></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain(RULE);
  });

  it("does not flag guilt-like phrasing in body copy (must be a control) [negative]", () => {
    const report = run(
      `<html><body><p>Some users say "I don't want to save money" — we disagree.</p></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain(RULE);
  });
});
