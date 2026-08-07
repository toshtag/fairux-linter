import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { dictionary, fairuxBuiltinRulePack } from "@fairux/rules";
import { describe, expect, it } from "vitest";
import { listRules, renderRuleListing } from "../src/list-rules.js";
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

function runCli(args: string[], cwd?: string): string {
  return execFileSync("node", [cliBin, ...args], {
    encoding: "utf8",
    cwd,
    timeout: CLI_SPAWN_TIMEOUT_MS,
  });
}

describe("fairux rules", () => {
  it("lists the built-in pack with a stable order", () => {
    const listing = listRules({});
    expect(listing.rulePacks.map((pack) => pack.id)).toEqual([fairuxBuiltinRulePack.meta.id]);
    expect(listing.rules).toHaveLength(fairuxBuiltinRulePack.rules.length);
    // Sorted by id, not by registry order: a list a user diffs between runs must not move because
    // a rule was added elsewhere in the registry.
    const ids = listing.rules.map((rule) => rule.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("reports effective severity, not the rule's default", () => {
    const listing = listRules({
      config: { rules: { "consent/checked-checkbox": { severity: "low" } } },
    });
    const rule = listing.rules.find((r) => r.id === "consent/checked-checkbox");
    expect(rule?.severity).toBe("low");
    expect(rule?.defaultSeverity).not.toBe("low");
    expect(rule?.configured).toBe(true);
  });

  it("separates the reasons a rule is not enabled", () => {
    // "You turned it off" and "it is experimental and you did not ask" produce the same silence in
    // a scan. They are different things to a user looking at a rule that did not run.
    const off = listRules({ config: { rules: { "scarcity/countdown-timer": false } } });
    expect(off.rules.find((r) => r.id === "scarcity/countdown-timer")).toMatchObject({
      enabled: false,
      reason: "disabled-by-override",
    });

    const experimental = listRules({});
    expect(experimental.rules.find((r) => r.experimental)).toMatchObject({
      enabled: false,
      reason: "experimental-excluded",
    });
  });

  it("lets an explicit override enable an experimental rule without the flag", () => {
    const listing = listRules({
      config: { rules: { "consent/accept-reject-visual-imbalance": true } },
    });
    expect(
      listing.rules.find((r) => r.id === "consent/accept-reject-visual-imbalance"),
    ).toMatchObject({ enabled: true, reason: "enabled-by-override" });
  });

  /**
   * The one failure this command cannot afford. If the listing and the scan beside it disagreed
   * about which rules run, the listing would be worse than nothing — and the way that happens is a
   * second reading of the activation order, which is why `@fairux/core` exports one.
   */
  it("agrees with what a scan actually runs, for every combination it can be asked about", () => {
    const html = `<html><body>
      <div role="dialog"><p>We use cookies.</p><button>Accept</button></div>
      <label><input type="checkbox" checked> Email me offers</label>
      <p>Only 2 left in stock!</p>
    </body></html>`;

    for (const [label, options] of [
      ["defaults", {}],
      ["experimental", { includeExperimental: true }],
      ["one disabled", { config: { rules: { "consent/checked-checkbox": false } } }],
      [
        "one experimental forced on",
        { config: { rules: { "consent/accept-reject-visual-imbalance": true } } },
      ],
    ] as const) {
      const listing = listRules(options);
      const report = scan(parseHtml(html), fairuxBuiltinRulePack.rules, {
        dictionary,
        includeExperimental: listing.includeExperimental,
        ruleOverrides: options.config?.rules,
      });

      const enabled = new Set(listing.rules.filter((r) => r.enabled).map((r) => r.id));
      const fired = new Set(report.findings.map((f) => f.ruleId));
      // Every rule that fired must be listed as enabled. The converse does not hold and must not be
      // asserted: an enabled rule is silent on a page it does not match, which is the boundary this
      // command states rather than hides.
      for (const ruleId of fired) {
        expect(enabled.has(ruleId), `${label}: ${ruleId} fired but is not listed as enabled`).toBe(
          true,
        );
      }
    }
  });

  it("never presents the enabled set as coverage", () => {
    // A list of enabled rules is exactly the thing that gets read as "this is what was checked".
    // Coverage is M3's subject, and until it exists this output must not imply it.
    const text = renderRuleListing(listRules({}));
    expect(text).toContain("not a coverage claim");
    expect(text).toContain("only on"); // a scoped rule's scope is shown, not hidden
  });
});

describe("fairux rules (end-to-end)", () => {
  it("prints the pack identity and an enabled count", () => {
    const out = runCli(["rules", "--ignore-config"]);
    expect(out).toContain(fairuxBuiltinRulePack.meta.id);
    expect(out).toMatch(/\d+ of \d+ rules enabled/);
  });

  it("emits parseable JSON whose shape is the documented one", () => {
    const listing = JSON.parse(runCli(["rules", "--ignore-config", "--format", "json"]));
    expect(Object.keys(listing).sort()).toEqual([
      "includeExperimental",
      "journeyRules",
      "rulePacks",
      "rules",
    ]);
    expect(listing.rules[0]).toHaveProperty("reason");
    expect(listing.rules[0]).toHaveProperty("severity");
  });

  it("changes the listed set with --include-experimental", () => {
    const plain = JSON.parse(runCli(["rules", "--ignore-config", "--format", "json"]));
    const withExperimental = JSON.parse(
      runCli(["rules", "--ignore-config", "--include-experimental", "--format", "json"]),
    );
    const count = (l: { rules: { enabled: boolean }[] }) => l.rules.filter((r) => r.enabled).length;
    expect(count(withExperimental)).toBeGreaterThan(count(plain));
  });

  it("reads the same auto-discovered config a scan would", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-rules-config-"));
    try {
      writeFileSync(
        join(tmp, "fairux.config.json"),
        JSON.stringify({ rules: { "scarcity/countdown-timer": false } }),
        "utf8",
      );
      const listing = JSON.parse(runCli(["rules", "--format", "json"], tmp));
      expect(
        listing.rules.find((r: { id: string }) => r.id === "scarcity/countdown-timer"),
      ).toMatchObject({ enabled: false, reason: "disabled-by-override" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 on an unknown format and 1 on a config error, like scan", () => {
    const badFormat = spawnSync("node", [cliBin, "rules", "--format", "toml"], {
      encoding: "utf8",
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
    expect(badFormat.status).toBe(2);
    expect(badFormat.stderr).toContain("unknown format");

    const tmp = mkdtempSync(join(tmpdir(), "fairux-rules-bad-config-"));
    try {
      writeFileSync(join(tmp, "fairux.config.json"), "{ invalid json", "utf8");
      const badConfig = spawnSync("node", [cliBin, "rules"], {
        encoding: "utf8",
        cwd: tmp,
        timeout: CLI_SPAWN_TIMEOUT_MS,
      });
      expect(badConfig.status).toBe(1);
      expect(badConfig.stderr).toContain("config error");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a config naming a rule id that does not exist", () => {
    // The reason the listing carries no "unknown rule id" field: a mistyped id never gets that far.
    const tmp = mkdtempSync(join(tmpdir(), "fairux-rules-typo-"));
    try {
      writeFileSync(
        join(tmp, "fairux.config.json"),
        JSON.stringify({ rules: { "consent/typo-rule": false } }),
        "utf8",
      );
      const result = spawnSync("node", [cliBin, "rules"], {
        encoding: "utf8",
        cwd: tmp,
        timeout: CLI_SPAWN_TIMEOUT_MS,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unknown rule id");
      expect(result.stderr).toContain("Known rule ids");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("fairux rules and capabilities", () => {
  it("lists what every rule requires, whether or not a runtime was named", () => {
    const listing = listRules({});
    expect(listing.runtime).toBeUndefined();
    for (const rule of listing.rules) {
      expect(rule.requiredCapabilities.length).toBeGreaterThan(0);
      // Nothing is marked unrunnable without a runtime to be unrunnable against.
      expect(rule.unsupportedOn).toBeUndefined();
    }
  });

  it("marks the rules a Figma input can never satisfy, and why", () => {
    const listing = listRules({ includeExperimental: true, runtime: "figma" });
    expect(listing.runtime).toBe("figma");
    expect(listing.runtimeCapabilities).toEqual(["structure", "text", "attributes"]);

    const blocked = listing.rules.filter((rule) => rule.unsupportedOn);
    expect(blocked.map((rule) => rule.id)).toEqual([
      "consent/accept-reject-visual-imbalance",
      "obstruction/modal-close-visibility",
    ]);
    for (const rule of blocked) expect(rule.unsupportedOn).toContain("style-hints");
  });

  it("marks nothing for an input that supplies what the built-in rules need", () => {
    const listing = listRules({ includeExperimental: true, runtime: "html" });
    expect(listing.rules.filter((rule) => rule.unsupportedOn)).toEqual([]);
  });

  it("agrees with what a scan of that runtime actually does", () => {
    // The listing and the engine read one table. If they ever disagreed, both would keep passing
    // their own tests while telling a user different things.
    const listing = listRules({ includeExperimental: true, runtime: "figma" });
    const report = scan(
      parseHtml("<main><button>Buy</button></main>"),
      fairuxBuiltinRulePack.rules,
      { dictionary, includeExperimental: true },
    );
    const htmlSkipped = (report.coverage?.rules ?? [])
      .filter((entry) => entry.skipReason === "missing-capability")
      .map((entry) => entry.ruleId);
    // Nothing is capability-skipped on HTML; the same two are unrunnable on Figma.
    expect(htmlSkipped).toEqual([]);
    expect(listing.rules.filter((rule) => rule.unsupportedOn)).toHaveLength(2);
  });

  it("says in the text output that a marked rule cannot run whatever the config says", () => {
    const out = renderRuleListing(listRules({ includeExperimental: true, runtime: "figma" }));
    expect(out).toContain("against a figma input, which supplies: structure, text, attributes");
    expect(out).toContain("cannot run here — needs style-hints");
    expect(out).toContain(
      "cannot run against a figma input at all, whatever the configuration says",
    );
    // Still not a coverage claim: this is a property of the input kind, not of a page that was read.
    expect(out).toContain("this list is not a coverage claim");
  });

  it("refuses an unknown runtime rather than listing as if none was given", () => {
    const res = spawnSync("node", [cliBin, "rules", "--runtime", "pdf"], {
      encoding: "utf8",
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('unknown runtime "pdf"');
  });

  it("carries the same fields through --format json", () => {
    const parsed = JSON.parse(runCli(["rules", "--runtime", "dom", "--format", "json"]));
    expect(parsed.runtime).toBe("dom");
    expect(parsed.runtimeCapabilities).toContain("dom-state");
    for (const rule of parsed.rules) expect(Array.isArray(rule.requiredCapabilities)).toBe(true);
  });
});

const flowPack = resolve(here, "../../../tests/fixtures/journey-rule-pack/flow-pack.mjs");

/**
 * A journey rule is enabled and a `scan` still never runs it. The listing has to say both, and it
 * must not let the second fact be inferred from a flag on a row nobody reads.
 */
describe("fairux rules and journey rules", () => {
  it("keeps journey rules out of the set a scan would run", () => {
    const listing = listRules({});
    expect(listing.journeyRules).toEqual([]);
    expect(listing.rules).toHaveLength(fairuxBuiltinRulePack.rules.length);
  });

  it("lists a loaded journey rule separately, and not among the scan's", () => {
    const output = runCli(["rules", "--rule-pack", flowPack]);
    expect(output).toContain("Journey rules — these run in `fairux scan-journey`");
    expect(output).toContain("fixtures/price-changed-across-steps");
    // The enabled count is about what a scan runs, so the journey rule must not move it.
    expect(output).toMatch(/\n11 of 13 rules enabled/);
    expect(output).toContain("1 of 1 journey rules enabled");
  });

  it("carries them as their own array in JSON, so a consumer cannot forget to filter", () => {
    const listing = JSON.parse(runCli(["rules", "--format", "json", "--rule-pack", flowPack])) as {
      rules: { id: string }[];
      journeyRules: { id: string; requiredCapabilities: string[]; rulePack: string }[];
    };
    expect(listing.rules.map((rule) => rule.id)).not.toContain(
      "fixtures/price-changed-across-steps",
    );
    expect(listing.journeyRules).toHaveLength(1);
    expect(listing.journeyRules[0]?.requiredCapabilities).toContain("journey");
    expect(listing.journeyRules[0]?.rulePack).toBe("@fixtures/flow");
  });

  it("says nothing about journey rules when a pack ships none", () => {
    // A heading over an empty list would suggest a feature the current rule set does not have.
    expect(runCli(["rules"])).not.toContain("Journey rules");
  });
});
