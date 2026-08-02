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

  it("flags a guilt clause whatever the refusal opens with [en]", () => {
    // The corpus recorded this as a miss from its first run. The opening is not the signal and never
    // was — "I don't like saving money" is the guilt clause, and it now matches wherever it appears.
    const report = run(
      `<html><body><div class="modal"><p>Get 20% off!</p>
        <button>Sign me up</button>
        <button>No thanks, I don't like saving money</button></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("does not flag a bare no thanks decline [negative]", () => {
    // The one the new pattern must not swallow. A decline that simply declines is not confirmshaming,
    // and a rule that flagged it would fire on most consent banners on the web.
    const report = run(
      `<html><body><div class="modal"><button>Sign me up</button>
        <button>No thanks</button></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(0);
  });

  /**
   * Every one of these is an ordinary decline that happens to open the same way.
   *
   * The first version of the widened pattern matched on the *verb after the pronoun* and stopped
   * there, so all seven fired. What makes a decline confirmshaming is the object — being made to say
   * you do not want the good thing — and a pattern that never reads the object is matching a
   * sentence opening, not a dark pattern.
   */
  it.each([
    "No thanks, I don't need newsletters",
    "No thanks, I do not want promotional emails",
    "No thanks, I am not interested",
    "No thanks, I'm not ready yet",
    "No thanks, I prefer the current plan",
    "No thanks, I would rather decide later",
    "No thanks, I'd rather keep my data private",
    "No thanks, I like the current plan",
  ])("does not flag the neutral decline %s [negative]", (label) => {
    const report = run(
      `<html><body><div class="modal"><button>Sign me up</button>
        <button>${label}</button></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(0);
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
