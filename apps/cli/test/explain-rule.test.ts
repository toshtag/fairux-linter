import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISCLAIMER } from "@fairux/report";
import { fairuxBuiltinRulePack } from "@fairux/rules";
import { describe, expect, it } from "vitest";
import { explainRule, renderRuleExplanation, UnknownRuleError } from "../src/explain-rule.js";
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const ruleIds = fairuxBuiltinRulePack.rules.map((rule) => rule.meta.id);

describe("fairux explain", () => {
  it("explains every rule in the built-in pack", () => {
    // A rule that cannot be explained is a rule whose governance record is incomplete, and this is
    // the cheapest place to find that out.
    for (const id of ruleIds) {
      expect(() => explainRule(id), id).not.toThrow();
    }
  });

  it("carries the governance record rather than prose written here", () => {
    const explanation = explainRule("consent/checked-checkbox");
    const meta = fairuxBuiltinRulePack.rules.find(
      (rule) => rule.meta.id === "consent/checked-checkbox",
    )?.meta;
    expect(explanation.maturity).toBe(meta?.maturity);
    expect(explanation.jurisdictions).toEqual(meta?.jurisdictions);
    expect(explanation.officialSources?.map((source) => source.id)).toEqual(
      meta?.officialSources?.map((source) => source.id),
    );
    expect(explanation.knownLimitations).toEqual(meta?.knownLimitations);
  });

  /**
   * The reason the command exists. `consent/checked-checkbox` records that a `checked` attribute may
   * not match runtime state after scripts run — the difference between a finding to act on and one
   * to dismiss. If that is buried or omitted, the output is decoration.
   */
  it("always carries a known-limitations section, even when the record states none", () => {
    for (const id of ruleIds) {
      expect(Array.isArray(explainRule(id).knownLimitations), id).toBe(true);
    }

    const text = renderRuleExplanation({
      ...explainRule("consent/checked-checkbox"),
      knownLimitations: [],
    });
    // An omitted section reads as "there are none", which is a stronger claim than the record makes.
    expect(text).toContain("Known limitations:");
    expect(text).toContain("states none");
    expect(text).toContain("not a guarantee");
  });

  it("puts the limitations before the sources", () => {
    // A reader who stops early should have read what decides whether to act, not the citations.
    const text = renderRuleExplanation(explainRule("consent/checked-checkbox"));
    expect(text.indexOf("Known limitations:")).toBeLessThan(text.indexOf("Review context"));
  });

  it("presents jurisdictions and sources as review context, never as a verdict", () => {
    const text = renderRuleExplanation(explainRule("consent/checked-checkbox"));
    expect(text).toContain("not a legal verdict");
    expect(text).toContain(DISCLAIMER);
    // No accusatory vocabulary anywhere in the rendering. FairUX returns risk signals.
    expect(text).not.toMatch(/\b(illegal|unlawful|violation|breach|non-?compliant)\b/i);
  });

  it("points at the finding for the text that belongs to a finding", () => {
    // A rule-level copy of "why it matters" would be a second wording that drifts from the one a
    // user actually reads in a report.
    const text = renderRuleExplanation(explainRule("consent/checked-checkbox"));
    expect(text).toContain("comes with the finding itself");
  });

  it("resolves enablement the same way fairux rules does", () => {
    const off = explainRule("scarcity/countdown-timer", {
      config: { rules: { "scarcity/countdown-timer": false } },
    });
    expect(off).toMatchObject({ enabled: false, reason: "disabled-by-override" });

    const experimental = explainRule("obstruction/modal-close-visibility");
    expect(experimental).toMatchObject({ enabled: false, reason: "experimental-excluded" });
    expect(
      explainRule("obstruction/modal-close-visibility", { includeExperimental: true }).enabled,
    ).toBe(true);
  });

  it("reports the effective severity and says it was overridden", () => {
    const explanation = explainRule("consent/checked-checkbox", {
      config: { rules: { "consent/checked-checkbox": { severity: "low" } } },
    });
    expect(explanation.severity).toBe("low");
    expect(renderRuleExplanation(explanation)).toContain("overridden by your config");
  });

  it("suggests the rules a wrong id was probably reaching for", () => {
    // Half-remembered id.
    expect(() => explainRule("checked-checkbox")).toThrow(/consent\/checked-checkbox/);
    // Right namespace, wrong rule: the namespace is the next most likely thing the user got right.
    const error = (() => {
      try {
        explainRule("consent/typo");
      } catch (thrown) {
        return thrown as UnknownRuleError;
      }
      throw new Error("expected explainRule to throw");
    })();
    expect(error).toBeInstanceOf(UnknownRuleError);
    expect(error.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of error.suggestions) expect(suggestion).toMatch(/^consent\//);
  });

  it("suggests nothing rather than everything when the id resembles no rule", () => {
    const error = (() => {
      try {
        explainRule("nonsense");
      } catch (thrown) {
        return thrown as UnknownRuleError;
      }
      throw new Error("expected explainRule to throw");
    })();
    expect(error.suggestions).toEqual([]);
  });
});

describe("fairux explain (end-to-end)", () => {
  const run = (args: string[]) =>
    spawnSync("node", [cliBin, ...args], { encoding: "utf8", timeout: CLI_SPAWN_TIMEOUT_MS });

  it("prints the explanation and exits 0", () => {
    const out = execFileSync(
      "node",
      [cliBin, "explain", "consent/checked-checkbox", "--ignore-config"],
      { encoding: "utf8", timeout: CLI_SPAWN_TIMEOUT_MS },
    );
    expect(out).toContain("Known limitations:");
    expect(out).toContain(DISCLAIMER);
  });

  it("emits parseable JSON", () => {
    const out = execFileSync(
      "node",
      [cliBin, "explain", "consent/checked-checkbox", "--ignore-config", "--format", "json"],
      { encoding: "utf8", timeout: CLI_SPAWN_TIMEOUT_MS },
    );
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe("consent/checked-checkbox");
    expect(parsed.knownLimitations.length).toBeGreaterThan(0);
    expect(parsed.disclaimer).toBe(DISCLAIMER);
  });

  it("exits 2 for an unknown rule id and for an unknown format", () => {
    // Both are the invocation naming something that does not exist, rather than a run that failed
    // partway through — which is what exit 1 means for `scan`.
    const unknownRule = run(["explain", "consent/typo", "--ignore-config"]);
    expect(unknownRule.status).toBe(2);
    expect(unknownRule.stderr).toContain("unknown rule id");

    const unknownFormat = run([
      "explain",
      "consent/checked-checkbox",
      "--ignore-config",
      "--format",
      "toml",
    ]);
    expect(unknownFormat.status).toBe(2);
  });
});
