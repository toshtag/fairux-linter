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
      /expected a real calendar date/,
    );
  });
});

describe("a suppression file's shape", () => {
  /**
   * The shape check used to be `/^\d{4}-\d{2}-\d{2}$/`, which accepts days that do not exist. That
   * is not a cosmetic gap: `isExpired` compares dates as strings, so `2026-02-30` sorts after every
   * real day in February and the suppression outlives the month it was written for. Nothing said so
   * — it read as a date, applied like a date, and expired on a day the calendar never reaches.
   */
  it("refuses a date-shaped string that is not a day", () => {
    for (const expiresOn of [
      "2026-02-30", // February never has 30 days
      "2025-02-29", // 2025 is not a leap year
      "2026-13-01", // no thirteenth month
      "2026-00-10", // no zeroth month
      "2026-04-31", // April has 30
      "2026-06-00", // no zeroth day
    ]) {
      expect(() => file([{ fingerprint: "aaa", reason: "r", expiresOn }]), expiresOn).toThrow(
        /expected a real calendar date/,
      );
    }
  });

  it("accepts the boundaries a real calendar has", () => {
    for (const expiresOn of [
      "2024-02-29", // a leap day
      "2000-02-29", // the century that is a leap year
      "2026-01-31",
      "2026-04-30",
      "2026-12-31",
      "2026-01-01",
    ]) {
      expect(() => file([{ fingerprint: "aaa", reason: "r", expiresOn }]), expiresOn).not.toThrow();
    }
  });

  it("refuses a non-leap century's 29 February", () => {
    // 1900 is divisible by 4 and is not a leap year. A hand-rolled `% 4` check would accept it.
    expect(() => file([{ fingerprint: "aaa", reason: "r", expiresOn: "1900-02-29" }])).toThrow(
      /expected a real calendar date/,
    );
  });

  it("refuses an expiry that is not a string at all", () => {
    for (const expiresOn of [20260101, null, { on: "2026-01-01" }, ["2026-01-01"]]) {
      expect(() => file([{ fingerprint: "aaa", reason: "r", expiresOn }])).toThrow(
        /expected a real calendar date/,
      );
    }
  });

  it("refuses one fingerprint carrying two reasons, and names both entries", () => {
    // The applier keys on the fingerprint, so it reads one of the two arguments and drops the
    // other without saying which — the reason is the whole feature, and half of it would be gone.
    expect(() =>
      file([
        { fingerprint: "aaa", reason: "first argument" },
        { fingerprint: "bbb", reason: "unrelated" },
        { fingerprint: "aaa", reason: "second argument" },
      ]),
    ).toThrow(/aaa twice, at entry 0 and entry 2/);
  });

  it("refuses an entry that is not an object", () => {
    for (const entry of [null, 42, "aaa", ["aaa"], true]) {
      expect(() => file([entry]), JSON.stringify(entry)).toThrow(/entry 0 is not an object/);
    }
  });

  it("refuses a ruleId of the wrong shape, which only ever reaches a reader", () => {
    for (const ruleId of [42, "", null, ["a"]]) {
      expect(() => file([{ fingerprint: "aaa", reason: "r", ruleId }])).toThrow(
        /expected a non-empty string/,
      );
    }
  });

  it("refuses a top-level value that is not an object", () => {
    for (const contents of ["[]", '"suppressions"', "42", "null"]) {
      expect(() => parseSuppressions(contents, "/tmp/s.json"), contents).toThrow(
        /is not an object/,
      );
    }
  });

  it("accepts a field it does not know, so a newer file stays readable", () => {
    const parsed = parseSuppressions(
      JSON.stringify({
        schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
        writtenBy: "a later version",
        entries: [{ fingerprint: "aaa", reason: "r", owner: "platform-team" }],
      }),
      "/tmp/s.json",
    );
    expect(parsed.entries).toHaveLength(1);
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
