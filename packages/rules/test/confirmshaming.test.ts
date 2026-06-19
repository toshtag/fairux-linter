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
