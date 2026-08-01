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

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

function runCli(args: string[], cwd?: string): string {
  return execFileSync("node", [cliBin, ...args], { encoding: "utf8", cwd, timeout: 10000 });
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
    expect(Object.keys(listing).sort()).toEqual(["includeExperimental", "rulePacks", "rules"]);
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
      timeout: 10000,
    });
    expect(badFormat.status).toBe(2);
    expect(badFormat.stderr).toContain("unknown format");

    const tmp = mkdtempSync(join(tmpdir(), "fairux-rules-bad-config-"));
    try {
      writeFileSync(join(tmp, "fairux.config.json"), "{ invalid json", "utf8");
      const badConfig = spawnSync("node", [cliBin, "rules"], {
        encoding: "utf8",
        cwd: tmp,
        timeout: 10000,
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
        timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unknown rule id");
      expect(result.stderr).toContain("Known rule ids");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
