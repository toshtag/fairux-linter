import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalFilterRecord, FairUxBatchReport, FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { BASELINE_SCHEMA_VERSION } from "../src/baseline.js";
import { SUPPRESSIONS_SCHEMA_VERSION } from "../src/suppressions.js";
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

/**
 * What a run detected, told apart from what it reported.
 *
 * `--suppress` and `--baseline` subtract from a report after the scan. Both already account for
 * every entry — applied, expired, unmatched, resolved — and both wrote that accounting to stderr,
 * which is the one place a stored artifact does not keep. What survives a CI run is the JSON a step
 * uploaded, the SARIF a code-scanning tab ingested, and the HTML somebody attached to a ticket. All
 * of them showed a short list of findings, and none of them said a file had made it short.
 *
 * The failure is not hypothetical arithmetic: a baseline is committed once and grows every time a
 * team accepts something, under a path that never changes. Two artifacts a year apart can differ by
 * twelve findings with nothing in either one naming the file that removed them.
 *
 * Everything here drives the built CLI, because the claim is about what the artifact says.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

const PAGE =
  "<html><body>" +
  '<label><input type="checkbox" checked> Email me offers</label>' +
  "<p>Only 2 left in stock!</p>" +
  "<p>Hurry, offer ends in 5 minutes!</p>" +
  "</body></html>";

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-provenance-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cli = (args: string[], cwd: string) =>
  spawnSync("node", [cliBin, ...args, "--ignore-config"], {
    encoding: "utf8",
    timeout: CLI_SPAWN_TIMEOUT_MS,
    cwd,
  });

const json = <T>(args: string[], cwd: string): T =>
  JSON.parse(cli([...args, "--format", "json"], cwd).stdout) as T;

interface Finding {
  readonly ruleId: string;
  readonly fingerprint: string;
}

/** A page, its findings, and the filter files built from them. */
/**
 * The fingerprints `PAGE` produces, discovered once for the whole file.
 *
 * Every case here needs them to write its filter files, and each one used to spawn the CLI again to
 * ask — fourteen scans of one unchanging page. A fingerprint is derived from the rule, the locator,
 * and the text, not from where the file sits, so the answer does not depend on the temporary
 * directory a case happens to be given; the assertion below is what keeps that from being a belief.
 *
 * Lazy rather than top-level, because the CLI has to be built before it can be asked and a module
 * body runs before any of that is arranged.
 */
let discovered: Finding[] | undefined;
function fingerprintsOfPage(): Finding[] {
  if (discovered) return discovered;
  const dir = mkdtempSync(join(tmpdir(), "fairux-provenance-discovery-"));
  try {
    writeFileSync(join(dir, "page.html"), PAGE, "utf8");
    const findings = json<FairUxReport>(["scan", "page.html"], dir)
      .findings as unknown as Finding[];
    expect(findings.length).toBeGreaterThanOrEqual(3);
    discovered = findings;
    return findings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setUp(dir: string) {
  writeFileSync(join(dir, "page.html"), PAGE, "utf8");
  const findings = fingerprintsOfPage();
  const [first, second, third] = findings as [Finding, Finding, Finding];

  const suppressions = {
    schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
    entries: [
      { fingerprint: first.fingerprint, ruleId: first.ruleId, reason: "agreed on the prior step" },
      { fingerprint: "0000000000000000", ruleId: "gone/away", reason: "fixed in March" },
      {
        fingerprint: second.fingerprint,
        ruleId: second.ruleId,
        reason: "was going to be revisited",
        expiresOn: "2020-01-01",
      },
    ],
  };
  const baseline = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    note: "Accepted risk, not resolved risk.",
    toolVersion: "0.0.0-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    entries: [
      { fingerprint: third.fingerprint, ruleId: third.ruleId },
      { fingerprint: "1111111111111111", ruleId: "gone/away" },
    ],
  };
  const suppressText = JSON.stringify(suppressions, null, 2);
  const baselineText = JSON.stringify(baseline, null, 2);
  writeFileSync(join(dir, "s.json"), suppressText, "utf8");
  writeFileSync(join(dir, "base.json"), baselineText, "utf8");
  return { first, second, third, findings, suppressText, baselineText };
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

const recordFor = (report: { externalFilters?: readonly ExternalFilterRecord[] }, kind: string) =>
  report.externalFilters?.find((entry) => entry.kind === kind);

describe("the report says what a filter file removed", () => {
  it("gives a page the same fingerprints wherever it sits", () => {
    // The premise the discovery cache above rests on, asserted rather than assumed. A fingerprint
    // is built from the rule, the locator, and the text; if a path ever leaked into it, every
    // filter file this suite writes would name findings that do not exist in the directory the case
    // is running in, and the failures would look like filter bugs.
    const scanIn = (dir: string) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      return json<FairUxReport>(["scan", "page.html"], dir).findings.map(
        (finding) => (finding as unknown as Finding).fingerprint,
      );
    };
    const here = withTempDir(scanIn);
    const elsewhere = withTempDir(scanIn);
    expect(here).toEqual(elsewhere);
    expect(here).toEqual(fingerprintsOfPage().map((finding) => finding.fingerprint));
  });

  it("says nothing at all when no filter file was passed", () => {
    // Absent, never empty. A report with no `externalFilters` had none, which is the claim the
    // field exists to be able to make.
    withTempDir((dir) => {
      setUp(dir);
      const report = json<FairUxReport>(["scan", "page.html"], dir);
      expect(Object.hasOwn(report, "externalFilters")).toBe(false);
    });
  });

  it("records what --suppress applied, what lapsed, and what matched nothing", () => {
    withTempDir((dir) => {
      const { first, second } = setUp(dir);
      const report = json<FairUxReport>(["scan", "page.html", "--suppress", "s.json"], dir);
      const record = recordFor(report, "suppressions");

      expect(record?.applied).toEqual([
        {
          fingerprint: first.fingerprint,
          ruleId: first.ruleId,
          reason: "agreed on the prior step",
          count: 1,
        },
      ]);
      // Separately, because they are different facts: an expired entry stopped applying and its
      // finding is in `findings`; an unmatched one never applied and is the entry to delete.
      expect(record?.expired?.[0]?.fingerprint).toBe(second.fingerprint);
      expect(record?.expired?.[0]?.expiresOn).toBe("2020-01-01");
      expect(record?.unmatched?.map((entry) => entry.fingerprint)).toEqual(["0000000000000000"]);
    });
  });

  it("records what --baseline applied and what it can drop", () => {
    withTempDir((dir) => {
      const { third } = setUp(dir);
      const report = json<FairUxReport>(["scan", "page.html", "--baseline", "base.json"], dir);
      const record = recordFor(report, "baseline");

      expect(record?.applied).toEqual([
        { fingerprint: third.fingerprint, ruleId: third.ruleId, count: 1 },
      ]);
      expect(record?.resolved?.map((entry) => entry.fingerprint)).toEqual(["1111111111111111"]);
      // No invented reason. A baseline has nowhere to put one, and an empty string here would make
      // it read as an argued suppression to anything consuming the two through one shape.
      expect(record?.applied?.[0] && "reason" in record.applied[0]).toBe(false);
    });
  });

  it("makes detected and reported different numbers a reader can compare", () => {
    withTempDir((dir) => {
      const { findings } = setUp(dir);
      const report = json<FairUxReport>(["scan", "page.html", "--suppress", "s.json"], dir);
      const record = recordFor(report, "suppressions");

      expect(record?.detected.total).toBe(findings.length);
      expect(record?.reported.total).toBe(report.findings.length);
      expect(record?.reported.total).toBeLessThan(record?.detected.total ?? 0);
      // The last filter's `reported` is the report's own summary, so the two cannot drift.
      expect(record?.reported).toEqual(report.summary);
    });
  });

  it("chains the two files so reported of one is detected of the next", () => {
    withTempDir((dir) => {
      setUp(dir);
      const report = json<FairUxReport>(
        ["scan", "page.html", "--suppress", "s.json", "--baseline", "base.json"],
        dir,
      );
      const [suppress, baseline] = report.externalFilters as [
        ExternalFilterRecord,
        ExternalFilterRecord,
      ];
      // Order is the order the filters ran, which is itself the contract: suppressions first, so a
      // finding covered by both is attributed to the argued one.
      expect(suppress.kind).toBe("suppressions");
      expect(baseline.kind).toBe("baseline");
      expect(baseline.detected).toEqual(suppress.reported);
      expect(baseline.reported).toEqual(report.summary);
    });
  });

  it("puts no absolute local path into any public artifact", () => {
    /**
     * Every scanned path already goes through `toStableReportPath` for two reasons that apply here
     * unchanged: two checkouts and two runners should produce the same artifact, and
     * `/Users/someone/clients/acme-redesign/…` is a fact about a machine and the person at it. The
     * filter records were the one path in a report that had not been put through it, and a report
     * gets uploaded to code scanning, attached to tickets, and committed.
     *
     * The filters are named by absolute path on the command line here on purpose — that is how a CI
     * job writes them, and it is the input that used to end up in the output verbatim.
     */
    withTempDir((dir) => {
      setUp(dir);
      const absoluteSuppress = join(dir, "s.json");
      const absoluteBaseline = join(dir, "base.json");
      const indexPath = join(dir, "risk-index.json");
      const args = [
        "scan",
        "page.html",
        "--suppress",
        absoluteSuppress,
        "--baseline",
        absoluteBaseline,
        "--risk-index",
        indexPath,
      ];

      for (const format of ["json", "markdown", "html", "sarif"] as const) {
        const output = cli([...args, "--format", format], dir).stdout;
        expect(output, `${format} leaks the temporary directory`).not.toContain(dir);
        expect(output, `${format} leaks an absolute path`).not.toMatch(/"(?:\/|[A-Za-z]:\\)/);
      }
      // The Risk Index is a written artifact of its own and quotes the same file.
      const index = readFileSync(indexPath, "utf8");
      expect(index).not.toContain(dir);
      // Still named, still auditable — by the name that was typed and by the digest beside it.
      const report = json<FairUxReport>([...args], dir);
      expect(report.externalFilters?.map((entry) => entry.file)).toEqual(["s.json", "base.json"]);
      expect(index).toContain("sha256:");
    });
  });

  it("does not call an inline-suppressed finding resolved", () => {
    /**
     * A baseline decides an entry is stale by looking for its fingerprint in the scan. A finding an
     * inline `fairux-disable-next-line` accepted never reaches `findings`, so its entry matched
     * nothing and the run advised deleting it — deleting the record of an accepted risk because a
     * *second* mechanism was also hiding it. The risk is still in the page, and after the deletion
     * nothing says it was ever accepted.
     *
     * Only fixable once `AppliedSuppression` carried a fingerprint: the record said a rule and a
     * line, and neither is what a baseline matches on.
     */
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const before = json<FairUxReport>(["scan", "page.html"], dir);
      const target = (before.findings as unknown as Finding[])[0] as Finding;

      // Now suppress that same finding inline, so it leaves `findings` entirely.
      // A newline after the directive as well as before it: `fairux-disable-next-line` applies to
      // the line *after* the comment, and without the second break the comment and the finding share
      // one line.
      const withDirective = PAGE.replace(
        "<html><body>",
        `<html><body>\n<!-- fairux-disable-next-line ${target.ruleId} -- accepted on the prior step -->\n`,
      );
      writeFileSync(join(dir, "page.html"), withDirective, "utf8");
      const suppressedReport = json<FairUxReport>(["scan", "page.html"], dir);
      const inline = suppressedReport.suppressed?.[0];
      expect(inline?.fingerprint, "the directive did not apply").toBeDefined();

      writeFileSync(
        join(dir, "base.json"),
        JSON.stringify({
          schemaVersion: BASELINE_SCHEMA_VERSION,
          note: "Accepted risk, not resolved risk.",
          toolVersion: "test",
          createdAt: "2026-01-01T00:00:00.000Z",
          entries: [{ fingerprint: inline?.fingerprint, ruleId: inline?.ruleId }],
        }),
        "utf8",
      );

      const after = json<FairUxReport>(["scan", "page.html", "--baseline", "base.json"], dir);
      const record = recordFor(after, "baseline");
      expect(record?.resolved ?? [], "an inline-suppressed finding is hidden, not gone").toEqual(
        [],
      );
      // And stderr says the same thing, since both read one application.
      const stderr = cli(["scan", "page.html", "--baseline", "base.json"], dir).stderr;
      expect(stderr).not.toContain("no longer appear");
    });
  });

  it("identifies the bytes that ran, not only the path that was typed", () => {
    withTempDir((dir) => {
      const { suppressText, baselineText, findings } = setUp(dir);
      const report = json<FairUxReport>(
        ["scan", "page.html", "--suppress", "s.json", "--baseline", "base.json"],
        dir,
      );
      expect(recordFor(report, "suppressions")?.digest).toBe(sha(suppressText));
      expect(recordFor(report, "baseline")?.digest).toBe(sha(baselineText));
      expect(recordFor(report, "baseline")?.identity).toEqual({
        schemaVersion: BASELINE_SCHEMA_VERSION,
        toolVersion: "0.0.0-test",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      // The point of the digest: the same path, a bigger file, a shorter report. Without it the two
      // artifacts differ only in counts nobody can attribute.
      const grown = JSON.parse(readFileSync(join(dir, "base.json"), "utf8"));
      grown.entries.push({
        fingerprint: (findings[1] as Finding).fingerprint,
        ruleId: (findings[1] as Finding).ruleId,
      });
      const grownText = JSON.stringify(grown, null, 2);
      writeFileSync(join(dir, "base.json"), grownText, "utf8");
      const after = json<FairUxReport>(["scan", "page.html", "--baseline", "base.json"], dir);
      expect(recordFor(after, "baseline")?.digest).not.toBe(sha(baselineText));
      expect(recordFor(after, "baseline")?.digest).toBe(sha(grownText));
    });
  });

  it("records it on a batch too, at the root where the file applies", () => {
    withTempDir((dir) => {
      setUp(dir);
      writeFileSync(join(dir, "other.html"), "<main><p>Only 2 left in stock!</p></main>", "utf8");
      const batch = json<FairUxBatchReport>(["scan", ".", "--suppress", "s.json"], dir);
      expect(batch.externalFilters).toHaveLength(1);
      expect(batch.externalFilters?.[0]?.reported).toEqual({
        total: batch.summary.total,
        bySeverity: batch.summary.bySeverity,
      });
      // Not copied into each input: a filter file is applied to the run, and an entry names a
      // fingerprint rather than a file.
      for (const sub of batch.reports) {
        expect(Object.hasOwn(sub, "externalFilters")).toBe(false);
      }
    });
  });
});

describe("every surface says a file removed something", () => {
  it("names the file, its digest, and what it took out in Markdown", () => {
    withTempDir((dir) => {
      const { first } = setUp(dir);
      const out = cli(
        ["scan", "page.html", "--format", "markdown", "--suppress", "s.json"],
        dir,
      ).stdout;
      expect(out).toContain("Removed by a filter file");
      expect(out).toContain("agreed on the prior step");
      expect(out).toContain(first.fingerprint);
      expect(out).toContain("detected");
    });
  });

  it("names it in HTML, with every value escaped", () => {
    withTempDir((dir) => {
      setUp(dir);
      writeFileSync(
        join(dir, "s.json"),
        JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [
            {
              fingerprint: "0000000000000000",
              ruleId: "gone/away",
              reason: "<script>alert(1)</script>",
            },
          ],
        }),
        "utf8",
      );
      const out = cli(
        ["scan", "page.html", "--format", "html", "--suppress", "s.json"],
        dir,
      ).stdout;
      expect(out).toContain("Removed by a filter file");
      expect(out).not.toContain("<script>alert(1)</script>");
      expect(out).toContain("&lt;script&gt;");
    });
  });

  it("publishes it in SARIF, beside the results it removed them from", () => {
    withTempDir((dir) => {
      const { first } = setUp(dir);
      const sarif = JSON.parse(
        cli(["scan", "page.html", "--format", "sarif", "--suppress", "s.json"], dir).stdout,
      );
      const record = sarif.runs[0].properties.fairux.externalFilters[0];
      expect(record.kind).toBe("suppressions");
      expect(record.applied[0].fingerprint).toBe(first.fingerprint);
      // Deliberately not a SARIF suppression object: the result was removed before SARIF was built,
      // so there is nothing for a suppression to attach to.
      expect(sarif.runs[0].results.some((r: { suppressions?: unknown }) => r.suppressions)).toBe(
        false,
      );
    });
  });

  it("puts a batch's record at the log root rather than in every run", () => {
    withTempDir((dir) => {
      setUp(dir);
      writeFileSync(join(dir, "other.html"), "<main><p>Only 2 left in stock!</p></main>", "utf8");
      const sarif = JSON.parse(
        cli(["scan", ".", "--format", "sarif", "--suppress", "s.json"], dir).stdout,
      );
      expect(sarif.properties.fairux.externalFilters).toHaveLength(1);
      for (const run of sarif.runs) {
        // Copying it into each run would claim each input was filtered by its own file.
        expect(run.properties.fairux.externalFilters).toBeUndefined();
      }
    });
  });

  it("tells the Risk Index that its inputs were subtracted from", () => {
    // A score, or an empty `contributingFindings`, computed after a baseline removed twelve
    // findings is indistinguishable from a clean page. "Zero findings is not zero risk" is a
    // standing caution; this is a specific fact about this report.
    withTempDir((dir) => {
      setUp(dir);
      const indexPath = join(dir, "risk-index.json");
      cli(
        [
          "scan",
          "page.html",
          "--format",
          "json",
          "--suppress",
          "s.json",
          "--risk-index",
          indexPath,
        ],
        dir,
      );
      const limitations: string[] = JSON.parse(readFileSync(indexPath, "utf8")).limitations;
      const named = limitations.filter((line) => line.includes("s.json"));
      expect(named).toHaveLength(1);
      expect(named[0]).toContain("sha256:");
      expect(named[0]).toContain("removed 1 finding(s)");
    });
  });

  it("leaves the Risk Index alone when no filter ran", () => {
    withTempDir((dir) => {
      setUp(dir);
      const indexPath = join(dir, "risk-index.json");
      cli(["scan", "page.html", "--format", "json", "--risk-index", indexPath], dir);
      const limitations: string[] = JSON.parse(readFileSync(indexPath, "utf8")).limitations;
      expect(limitations.some((line) => line.includes("before this was computed"))).toBe(false);
    });
  });
});
