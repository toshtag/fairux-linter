import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import {
  applyBaseline,
  BASELINE_SCHEMA_VERSION,
  BaselineError,
  createBaseline,
  describeBaselineApplication,
  parseBaseline,
} from "../src/baseline.js";
import { batchReport } from "./report-builders.js";

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

const finding = (fingerprint: string, severity = "medium") =>
  ({
    id: `F-${fingerprint}`,
    ruleId: "consent/checked-checkbox",
    fingerprint,
    severity,
    evidence: [{ source: { file: "src/a.html" } }],
  }) as unknown as FairUxReport["findings"][number];

const report = (fingerprints: string[]): FairUxReport =>
  ({
    schemaVersion: "0.1",
    toolVersion: "test",
    input: { runtime: "html", file: "src/a.html" },
    summary: {
      total: fingerprints.length,
      bySeverity: { info: 0, low: 0, medium: fingerprints.length, high: 0 },
    },
    findings: fingerprints.map((fingerprint) => finding(fingerprint)),
  }) as unknown as FairUxReport;

describe("writing a baseline", () => {
  it("records one entry per fingerprint, sorted", () => {
    // Sorted because a baseline is committed: one that reordered itself would diff on every write.
    const baseline = createBaseline(report(["ccc", "aaa", "bbb", "aaa"]), {
      toolVersion: "1.2.3",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(baseline.entries.map((entry) => entry.fingerprint)).toEqual(["aaa", "bbb", "ccc"]);
    expect(baseline.toolVersion).toBe("1.2.3");
    expect(baseline.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("says what it is, in the file", () => {
    // Whoever finds this file in a year should not have to guess whether it means "fixed".
    const baseline = createBaseline(report(["aaa"]), { toolVersion: "1.0.0" });
    expect(baseline.note).toContain("Accepted risk, not resolved risk");
    expect(baseline.note).toContain("still present and still true");
    // And the limitation that will eventually surprise someone.
    expect(baseline.note).toContain("restructured");
  });
});

/** A valid v1 envelope, so a case below only varies the one field it is about. */
const envelope = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: BASELINE_SCHEMA_VERSION,
  note: "Accepted risk, not resolved risk.",
  toolVersion: "0.1.0",
  createdAt: "2026-01-01T00:00:00.000Z",
  entries: [],
  ...overrides,
});

const parse = (overrides: Record<string, unknown> = {}) =>
  parseBaseline(JSON.stringify(envelope(overrides)), "/tmp/b.json");

describe("reading a baseline", () => {
  it("refuses a file it does not understand rather than treating it as empty", () => {
    // An unreadable baseline read as empty is a baseline that silently stops working.
    expect(() => parseBaseline("{ not json", "/tmp/b.json")).toThrow(BaselineError);
    expect(() => parseBaseline(JSON.stringify({ entries: [] }), "/tmp/b.json")).toThrow(
      /schemaVersion/,
    );
    expect(() =>
      parseBaseline(JSON.stringify(envelope({ entries: undefined })), "/tmp/b.json"),
    ).toThrow(/entries array/);
    expect(() => parse({ entries: [{ ruleId: "x" }] })).toThrow(/no fingerprint/);
  });

  /**
   * The whole consumed v1 shape, not only what `applyBaseline` dereferences.
   *
   * A baseline is committed and read back a year later by whoever inherited it. `note` says what
   * the file is, `toolVersion` and `createdAt` say what wrote it and when — and a file missing them
   * is not a v1 file this tool wrote, which reading it as one hides.
   */
  it("refuses a v1 envelope missing what a v1 file carries", () => {
    expect(() => parse({ note: undefined })).toThrow(/has no note/);
    expect(() => parse({ note: "   " })).toThrow(/has no note/);
    expect(() => parse({ toolVersion: undefined })).toThrow(/has no toolVersion/);
    expect(() => parse({ toolVersion: 1 })).toThrow(/has no toolVersion/);
    expect(() => parse({ createdAt: undefined })).toThrow(/expected an ISO 8601 date-time/);
    for (const createdAt of ["yesterday", "2026-01-01", "December 17, 1995", "2026", 20260101]) {
      expect(() => parse({ createdAt }), String(createdAt)).toThrow(
        /expected an ISO 8601 date-time/,
      );
    }
  });

  it("keeps reading a valid v1 file whose prose or precision is not this version's", () => {
    // The note is allowed to be reworded and is never compared to the generator's text; a file
    // written before the milliseconds or with an offset instead of `Z` is a real instant.
    expect(() => parse({ note: "Accepted risk. We will get to these." })).not.toThrow();
    expect(() => parse({ createdAt: "2026-01-01T00:00:00Z" })).not.toThrow();
    expect(() => parse({ createdAt: "2026-01-01T09:00:00+09:00" })).not.toThrow();
    expect(
      parse({ writtenBy: "a later version", entries: [{ fingerprint: "a", ruleId: "r", tag: 1 }] })
        .entries,
    ).toHaveLength(1);
  });

  it("refuses an entry that is not a usable v1 entry", () => {
    for (const entry of [null, 42, "aaa", ["aaa"]]) {
      expect(() => parse({ entries: [entry] }), JSON.stringify(entry)).toThrow(
        /entry 0 is not an object/,
      );
    }
    expect(() => parse({ entries: [{ fingerprint: "aaa" }] })).toThrow(/has no ruleId/);
    expect(() => parse({ entries: [{ fingerprint: "aaa", ruleId: "" }] })).toThrow(/has no ruleId/);
    expect(() => parse({ entries: [{ fingerprint: "aaa", ruleId: "r", file: 7 }] })).toThrow(
      /expected a non-empty string/,
    );
    expect(() =>
      parse({ entries: [{ fingerprint: "aaa", ruleId: "r", file: "a.html" }] }),
    ).not.toThrow();
  });

  it("refuses one fingerprint twice, and names both entries", () => {
    // `createBaseline` never writes one, so a duplicate means the file was edited or merged — and a
    // file whose entry count disagrees with what it accepts is one nobody can audit against a scan.
    expect(() =>
      parse({
        entries: [
          { fingerprint: "aaa", ruleId: "r" },
          { fingerprint: "bbb", ruleId: "r" },
          { fingerprint: "aaa", ruleId: "r" },
        ],
      }),
    ).toThrow(/aaa twice, at entry 0 and entry 2/);
  });

  it("refuses a top-level value that is not an object", () => {
    for (const contents of ["[]", '"baseline"', "42", "null"]) {
      expect(() => parseBaseline(contents, "/tmp/b.json"), contents).toThrow(/is not an object/);
    }
  });

  it("reads back what the generator writes", () => {
    // The one case that must never break: this repository's own writer and reader agree.
    const written = createBaseline(report(["aaa", "bbb"]), { toolVersion: "9.9.9" });
    expect(parseBaseline(JSON.stringify(written), "/tmp/b.json").entries).toHaveLength(2);
  });
});

describe("applying a baseline", () => {
  const baseline = createBaseline(report(["aaa", "bbb"]), { toolVersion: "test" });

  it("subtracts recorded findings and recomputes the summary", () => {
    // A report whose summary disagreed with its own findings array is one no consumer can trust.
    const applied = applyBaseline(report(["aaa", "bbb", "ccc"]), baseline);
    expect(applied.report.findings.map((f) => f.fingerprint)).toEqual(["ccc"]);
    expect(applied.report.summary.total).toBe(1);
    expect(applied.report.summary.bySeverity.medium).toBe(1);
    expect(applied.suppressed).toBe(2);
  });

  it("keeps a mixed-runtime batch's breakdown through a baseline", () => {
    const batch = batchReport([
      { file: "a.html", runtime: "html", findings: ["aaa"] },
      { file: "b.tsx", runtime: "ast", findings: ["ccc"] },
      { file: "c.figjson", runtime: "figma", figmaFile: "Checkout", findings: ["bbb"] },
    ]);
    const applied = applyBaseline(batch, baseline);
    expect(applied.report.summary.byRuntime?.html?.total).toBe(0);
    expect(applied.report.summary.byRuntime?.figma?.total).toBe(0);
    expect(applied.report.summary.byRuntime?.ast?.total).toBe(1);
    expect(applied.report.inputs[2]?.figmaFile).toBe("Checkout");
  });

  it("reports baselined findings that no longer appear", () => {
    const applied = applyBaseline(report(["aaa"]), baseline);
    expect(applied.resolved.map((entry) => entry.fingerprint)).toEqual(["bbb"]);
  });

  it("asks what reached the filters, not what survived them, before calling an entry stale", () => {
    // A caller may subtract before this runs. "Gone" and "hidden by that earlier subtraction" then
    // look identical from here, and only the first is a reason to delete a baseline entry: a
    // finding still present before that subtraction is hidden, and its entry has not gone stale.
    const wider = createBaseline(report(["aaa", "bbb", "ccc"]), { toolVersion: "test" });
    const applied = applyBaseline(report(["bbb"]), wider, report(["aaa", "bbb"]));

    expect(applied.report.findings).toEqual([]);
    expect(applied.suppressed).toBe(1);
    // `aaa` did not reach this call's report and is still being reported by the one before it.
    expect(applied.resolved.map((entry) => entry.fingerprint)).toEqual(["ccc"]);
  });

  it("takes the report itself when it is not told otherwise", () => {
    // The third argument defaults to the first, which is what every caller with nothing in front of
    // it needs. Asserted so the default cannot quietly change under one.
    const wider = createBaseline(report(["aaa", "bbb", "ccc"]), { toolVersion: "test" });
    expect(
      applyBaseline(report(["bbb"]), wider).resolved.map((entry) => entry.fingerprint),
    ).toEqual(["aaa", "ccc"]);
  });

  // A single report and a batch cannot answer each other's liveness question. That is a compile-time
  // contract and lives in `baseline.typecheck.ts`, which `tsc` reads and Vitest does not — a
  // rejected call has no business running.

  it("subtracts inside every sub-report of a batch, and in its summary", () => {
    // Built, not cast — see `report-builders.ts` for why the cast this replaces made the fixture
    // agree with the defect it was supposed to catch.
    const batch = batchReport([
      { file: "a.html", findings: ["aaa", "ccc"] },
      { file: "b.html", findings: ["bbb"] },
    ]);

    const applied = applyBaseline(batch, baseline);
    expect(applied.report.reports[0]?.findings.map((f) => f.fingerprint)).toEqual(["ccc"]);
    expect(applied.report.reports[1]?.findings).toEqual([]);
    expect(applied.report.reports[1]?.summary.total).toBe(0);
    expect(applied.report.summary.total).toBe(1);
    expect(applied.suppressed).toBe(2);
  });

  it("never lets a baselined run read as clean", () => {
    // A run that hid twelve findings and said nothing would be worse than having no baseline.
    const message = describeBaselineApplication(
      applyBaseline(report(["aaa", "bbb"]), baseline),
      "b.json",
    );
    expect(message).toContain("suppressed 2 finding(s)");
    expect(message).toContain("accepted risk, not resolved risk");
  });

  it("says so even when it suppressed nothing", () => {
    // Otherwise "the baseline is empty" and "the baseline was not applied" look identical.
    expect(
      describeBaselineApplication(applyBaseline(report(["zzz"]), baseline), "b.json"),
    ).toContain("suppressed 0 finding(s)");
  });
});

describe("fairux scan --baseline (end-to-end)", () => {
  const page =
    '<html><body><label><input type="checkbox" checked> Email me offers</label>' +
    "<p>Only 2 left in stock!</p></body></html>";

  const run = (args: string[], cwd: string) =>
    spawnSync("node", [cliBin, ...args], { encoding: "utf8", timeout: 20000, cwd });

  it("turns a failing run green and reports what it hid", () => {
    withTempDir("fairux-baseline-", (dir) => {
      const file = join(dir, "a.html");
      writeFileSync(file, page, "utf8");
      const baselinePath = join(dir, "baseline.json");

      expect(run(["scan", file, "--ignore-config", "--fail-on", "info"], dir).status).toBe(1);

      const written = run(["scan", file, "--ignore-config", "--write-baseline", baselinePath], dir);
      expect(written.status).toBe(0);
      // Writing a baseline does not also emit a report: a command that both wrote one and passed
      // would be a command that never fails.
      expect(written.stdout.trim()).toBe("");
      expect(written.stderr).toContain("accepted risk, not resolved risk");

      const baselined = run(
        ["scan", file, "--ignore-config", "--fail-on", "info", "--baseline", baselinePath],
        dir,
      );
      expect(baselined.status).toBe(0);
      expect(baselined.stderr).toContain("suppressed 2 finding(s)");
      expect(JSON.parse(readFileSync(baselinePath, "utf8")).entries).toHaveLength(2);
    });
  });

  it("still fails on a finding the baseline does not cover", () => {
    withTempDir("fairux-baseline-new-", (dir) => {
      const file = join(dir, "a.html");
      writeFileSync(file, page, "utf8");
      const baselinePath = join(dir, "baseline.json");
      run(["scan", file, "--ignore-config", "--write-baseline", baselinePath], dir);

      writeFileSync(file, `${page}<button>Buy now</button><p>Hurry, only 1 left!</p>`, "utf8");
      const result = run(
        [
          "scan",
          file,
          "--format",
          "json",
          "--ignore-config",
          "--fail-on",
          "info",
          "--baseline",
          baselinePath,
        ],
        dir,
      );
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.summary.total).toBeGreaterThan(0);
      // The threshold read the same subtracted report the output shows.
      expect(report.findings.length).toBe(report.summary.total);
    });
  });

  it("does not rewrite the baseline during a normal scan", () => {
    withTempDir("fairux-baseline-stable-", (dir) => {
      const file = join(dir, "a.html");
      writeFileSync(file, page, "utf8");
      const baselinePath = join(dir, "baseline.json");
      run(["scan", file, "--ignore-config", "--write-baseline", baselinePath], dir);
      const before = readFileSync(baselinePath, "utf8");

      writeFileSync(file, "<html><body><p>nothing here</p></body></html>", "utf8");
      const result = run(["scan", file, "--ignore-config", "--baseline", baselinePath], dir);
      // A file that rewrites itself when findings change is a file that never fails.
      expect(readFileSync(baselinePath, "utf8")).toBe(before);
      expect(result.stderr).toContain("no longer appear");
    });
  });

  it("fails clearly on a missing or malformed baseline", () => {
    withTempDir("fairux-baseline-bad-", (dir) => {
      const file = join(dir, "a.html");
      writeFileSync(file, page, "utf8");

      const missing = run(["scan", file, "--ignore-config", "--baseline", "nope.json"], dir);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("baseline file not found");
      expect(missing.stdout.trim()).toBe("");

      const badPath = join(dir, "bad.json");
      writeFileSync(badPath, "{ not json", "utf8");
      const bad = run(["scan", file, "--ignore-config", "--baseline", badPath], dir);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("not valid JSON");
    });
  });
});
