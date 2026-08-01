import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxBatchReport, FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import {
  applySuppressions,
  describeSuppressionApplication,
  isExpired,
  parseSuppressions,
  SUPPRESSIONS_SCHEMA_VERSION,
  SuppressionsError,
} from "../src/suppressions.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

function withTempDir<T>(prefix: string, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const report = (fingerprints: string[]): FairUxReport =>
  ({
    schemaVersion: "0.1",
    toolVersion: "test",
    input: { runtime: "html", file: "a.html" },
    summary: {
      total: fingerprints.length,
      bySeverity: { info: 0, low: 0, medium: fingerprints.length, high: 0 },
    },
    findings: fingerprints.map((fingerprint) => ({
      id: `F-${fingerprint}`,
      ruleId: "scarcity/scarcity-phrase",
      fingerprint,
      severity: "medium",
      evidence: [],
    })),
  }) as unknown as FairUxReport;

const file = (entries: unknown[]) =>
  parseSuppressions(
    JSON.stringify({ schemaVersion: SUPPRESSIONS_SCHEMA_VERSION, entries }),
    "/tmp/s.json",
  );

describe("a suppression must carry an argument", () => {
  /**
   * The refusal this feature exists for. A suppression whose reason is `""` is a disabled rule with
   * extra steps, and `fairux.config.json` already disables rules — doing it twice in two places is
   * how the two disagree.
   */
  it("refuses a missing, empty, or whitespace-only reason", () => {
    for (const entry of [
      { fingerprint: "aaa" },
      { fingerprint: "aaa", reason: "" },
      { fingerprint: "aaa", reason: "   " },
      { fingerprint: "aaa", reason: 42 },
    ]) {
      expect(() => file([entry]), JSON.stringify(entry)).toThrow(/has no reason/);
    }
  });

  it("names the entry that is wrong", () => {
    expect(() => file([{ fingerprint: "aaa", reason: "fine" }, { fingerprint: "bbb" }])).toThrow(
      /entry 1 \(bbb\)/,
    );
  });

  it("refuses a file it does not understand rather than treating it as empty", () => {
    expect(() => parseSuppressions("{ nope", "/tmp/s.json")).toThrow(SuppressionsError);
    expect(() => parseSuppressions(JSON.stringify({ entries: [] }), "/tmp/s.json")).toThrow(
      /schemaVersion/,
    );
    expect(() =>
      parseSuppressions(
        JSON.stringify({ schemaVersion: SUPPRESSIONS_SCHEMA_VERSION }),
        "/tmp/s.json",
      ),
    ).toThrow(/entries array/);
  });

  it("refuses an expiry that is not a date", () => {
    expect(() => file([{ fingerprint: "aaa", reason: "r", expiresOn: "next tuesday" }])).toThrow(
      /expected YYYY-MM-DD/,
    );
  });
});

describe("expiry", () => {
  const entry = { fingerprint: "aaa", reason: "r", expiresOn: "2026-06-30" };

  it("applies through the whole of its last day", () => {
    // Compared as strings, so nobody has to answer what timezone a date in a file expires in.
    expect(isExpired(entry, "2026-06-29")).toBe(false);
    expect(isExpired(entry, "2026-06-30")).toBe(false);
    expect(isExpired(entry, "2026-07-01")).toBe(true);
  });

  it("never expires an entry with no date", () => {
    expect(isExpired({ fingerprint: "aaa", reason: "r" }, "2099-01-01")).toBe(false);
  });
});

describe("applying suppressions", () => {
  const suppressions = file([
    { fingerprint: "aaa", reason: "deliberate", ruleId: "scarcity/scarcity-phrase" },
    { fingerprint: "bbb", reason: "lapsed", expiresOn: "2020-01-01" },
    { fingerprint: "zzz", reason: "long gone" },
  ]);

  it("removes an active entry's finding and recomputes the summary", () => {
    const applied = applySuppressions(report(["aaa", "ccc"]), suppressions, "2026-08-01");
    expect(applied.report.findings.map((f) => f.fingerprint)).toEqual(["ccc"]);
    expect(applied.report.summary.total).toBe(1);
    expect(applied.applied).toEqual([{ entry: suppressions.entries[0], count: 1 }]);
  });

  it("lets an expired entry's finding through, and says the entry lapsed", () => {
    const applied = applySuppressions(report(["bbb"]), suppressions, "2026-08-01");
    expect(applied.report.findings.map((f) => f.fingerprint)).toEqual(["bbb"]);
    expect(applied.expired.map((entry) => entry.fingerprint)).toEqual(["bbb"]);
  });

  it("separates an unused entry from an expired one", () => {
    // They look identical in a report that only counted suppressions, and mean different things:
    // one is stale, the other has stopped protecting anything.
    const applied = applySuppressions(report(["aaa"]), suppressions, "2026-08-01");
    expect(applied.unmatched.map((entry) => entry.fingerprint)).toEqual(["zzz"]);
    expect(applied.expired.map((entry) => entry.fingerprint)).toEqual(["bbb"]);
  });

  it("removes across every sub-report of a batch", () => {
    const batch = {
      schemaVersion: "0.1",
      toolVersion: "test",
      inputs: [{ file: "a.html" }, { file: "b.html" }],
      reports: [report(["aaa"]), report(["aaa", "ccc"])],
      summary: { total: 3, bySeverity: { info: 0, low: 0, medium: 3, high: 0 } },
    } as unknown as FairUxBatchReport;

    const applied = applySuppressions(batch, suppressions, "2026-08-01");
    expect(applied.report.reports[0]?.findings).toEqual([]);
    expect(applied.report.reports[1]?.findings.map((f) => f.fingerprint)).toEqual(["ccc"]);
    expect(applied.report.summary.total).toBe(1);
    // Counted once per finding removed, not once per entry.
    expect(applied.applied[0]?.count).toBe(2);
  });

  it("prints the reason, not just a count", () => {
    // A suppression nobody can see is a rule that was silently turned off; the argument is the only
    // thing distinguishing the two.
    const message = describeSuppressionApplication(
      applySuppressions(report(["aaa", "bbb"]), suppressions, "2026-08-01"),
      "s.json",
    );
    expect(message).toContain("deliberate");
    expect(message).toContain("EXPIRED 2020-01-01");
    expect(message).toContain("unused:");
  });
});

describe("fairux scan --suppress (end-to-end)", () => {
  const page =
    '<html><body><label><input type="checkbox" checked> Email me offers</label>' +
    "<p>Only 2 left in stock!</p></body></html>";

  const run = (args: string[], cwd: string) =>
    spawnSync("node", [cliBin, ...args], { encoding: "utf8", timeout: 20000, cwd });

  const fingerprintOf = (dir: string, target: string, ruleId: string): string => {
    const result = run(["scan", target, "--format", "json", "--ignore-config"], dir);
    const parsed = JSON.parse(result.stdout);
    const finding = parsed.findings.find((f: { ruleId: string }) => f.ruleId === ruleId);
    if (!finding) throw new Error(`expected a ${ruleId} finding`);
    return finding.fingerprint;
  };

  it("removes the finding, keeps the others, and prints the reason", () => {
    withTempDir("fairux-suppress-", (dir) => {
      const target = join(dir, "a.html");
      writeFileSync(target, page, "utf8");
      const fingerprint = fingerprintOf(dir, target, "scarcity/scarcity-phrase");
      const suppressPath = join(dir, "suppressions.json");
      writeFileSync(
        suppressPath,
        JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [
            {
              fingerprint,
              ruleId: "scarcity/scarcity-phrase",
              reason: "Stock count is live from inventory; the scarcity is real.",
            },
          ],
        }),
        "utf8",
      );

      const result = run(
        ["scan", target, "--format", "json", "--ignore-config", "--suppress", suppressPath],
        dir,
      );
      const report = JSON.parse(result.stdout);
      expect(report.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual([
        "consent/checked-checkbox",
      ]);
      expect(result.stderr).toContain("the scarcity is real");
    });
  });

  it("keeps a suppressed finding out of --fail-on", () => {
    withTempDir("fairux-suppress-fail-", (dir) => {
      const target = join(dir, "a.html");
      writeFileSync(target, "<html><body><p>Only 2 left in stock!</p></body></html>", "utf8");
      const fingerprint = fingerprintOf(dir, target, "scarcity/scarcity-phrase");
      const suppressPath = join(dir, "s.json");
      writeFileSync(
        suppressPath,
        JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [{ fingerprint, reason: "deliberate" }],
        }),
        "utf8",
      );

      expect(run(["scan", target, "--ignore-config", "--fail-on", "info"], dir).status).toBe(1);
      expect(
        run(
          ["scan", target, "--ignore-config", "--fail-on", "info", "--suppress", suppressPath],
          dir,
        ).status,
      ).toBe(0);
    });
  });

  it("lets an expired suppression's finding fail the build again", () => {
    withTempDir("fairux-suppress-expired-", (dir) => {
      const target = join(dir, "a.html");
      writeFileSync(target, "<html><body><p>Only 2 left in stock!</p></body></html>", "utf8");
      const fingerprint = fingerprintOf(dir, target, "scarcity/scarcity-phrase");
      const suppressPath = join(dir, "s.json");
      writeFileSync(
        suppressPath,
        JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [{ fingerprint, reason: "was deliberate", expiresOn: "2020-01-01" }],
        }),
        "utf8",
      );

      const result = run(
        ["scan", target, "--ignore-config", "--fail-on", "info", "--suppress", suppressPath],
        dir,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("EXPIRED 2020-01-01");
    });
  });

  it("refuses a reasonless file before scanning anything", () => {
    withTempDir("fairux-suppress-bad-", (dir) => {
      const target = join(dir, "a.html");
      writeFileSync(target, page, "utf8");
      const suppressPath = join(dir, "s.json");
      writeFileSync(
        suppressPath,
        JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [{ fingerprint: "a" }],
        }),
        "utf8",
      );

      const result = run(["scan", target, "--ignore-config", "--suppress", suppressPath], dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("has no reason");
      expect(result.stdout.trim()).toBe("");
    });
  });
});
