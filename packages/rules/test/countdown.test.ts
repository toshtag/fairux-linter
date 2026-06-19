import { describe, expect, it } from "vitest";
import { allRules } from "../src/index.js";
import { findingsFor, ruleIds, run } from "./_util.js";

const RULE = "scarcity/countdown-timer";

describe("scarcity/countdown-timer", () => {
  it("flags an explicit HH:MM:SS clock [en]", () => {
    const report = run(`<html><body><p>Offer ends in 00:14:59</p></body></html>`, allRules);
    const hits = findingsFor(report, RULE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("low");
  });

  it("flags a data-countdown element with no visible text", () => {
    const report = run(`<html><body><div data-countdown="3600"></div></body></html>`, allRules);
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("flags a countdown by class name", () => {
    const report = run(
      `<html><body><div class="sale-countdown">Hurry</div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("flags a Japanese countdown [ja]", () => {
    const report = run(
      `<html lang="ja"><body><p>セール終了まで 残り 2 時間</p></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("dedups a wrapper + its inner clock to one finding", () => {
    const report = run(
      `<html><body><div class="countdown"><span>00:09:59</span></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("does not flag a normal time like a clock label [negative]", () => {
    const report = run(`<html><body><p>Open 9:00 to 17:00 daily</p></body></html>`, allRules);
    expect(ruleIds(report)).not.toContain(RULE);
  });

  it("does not flag plain content [negative]", () => {
    const report = run(`<html><body><p>Welcome to our store.</p></body></html>`, allRules);
    expect(ruleIds(report)).not.toContain(RULE);
  });
});
