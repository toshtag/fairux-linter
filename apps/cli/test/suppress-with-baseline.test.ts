import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASELINE_SCHEMA_VERSION } from "../src/baseline.js";
import { SUPPRESSIONS_SCHEMA_VERSION } from "../src/suppressions.js";

/**
 * `--suppress` and `--baseline` are two subtractions applied to one report, and the order they
 * compose in is a contract: suppressions first, so a finding covered by both is attributed to the
 * one carrying an argument. Each flag has its own tests; this file is about what happens when both
 * are on the command line, which is the case neither of them covers.
 */

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

const run = (args: string[], cwd: string) =>
  spawnSync("node", [cliBin, ...args], { encoding: "utf8", timeout: 20000, cwd });

/**
 * Five findings, because the interesting cases need four distinct roles plus one spare: a finding
 * only the suppression file names, one only the baseline names, one both name, and ones neither
 * does. The two `consent/checked-checkbox` findings are `high`, which is what lets `--fail-on high`
 * tell the roles apart.
 */
const page =
  "<html><body>" +
  '<label><input type="checkbox" checked> Email me offers</label>' +
  "<p>Only 2 left in stock!</p>" +
  "<button>Buy now</button>" +
  '<a href="#">Continue</a>' +
  "<p>Hurry, offer ends in 5 minutes!</p>" +
  '<label><input type="checkbox" checked> Share my data with partners</label>' +
  "</body></html>";

interface Roles {
  readonly target: string;
  /** Named by the suppression file only. `high`, so its revival is visible to `--fail-on high`. */
  readonly suppressedOnly: Finding;
  /** Named by the baseline only. Also `high`, so the two files are not distinguished by severity. */
  readonly baselinedOnly: Finding;
  /** Named by both, which is the case the ordering contract exists to decide. */
  readonly both: Finding;
  /** Named by neither. These, and only these, are what the run should report. */
  readonly neither: readonly Finding[];
}

interface Finding {
  readonly ruleId: string;
  readonly severity: string;
  readonly fingerprint: string;
}

/**
 * Fingerprints are computed from the markup, so they are read back from a real scan rather than
 * written down here: a test carrying literal fingerprints would start passing for the wrong reason
 * the first time a locator changed.
 */
function setUp(dir: string): Roles {
  const target = join(dir, "a.html");
  writeFileSync(target, page, "utf8");

  const scanned = run(["scan", target, "--format", "json", "--ignore-config"], dir);
  const findings: Finding[] = JSON.parse(scanned.stdout).findings;
  const high = findings.filter((finding) => finding.severity === "high");
  const rest = findings.filter((finding) => finding.severity !== "high");
  // If the built-in rules stop producing this shape the roles below are meaningless, so say that
  // here rather than letting the assertions fail somewhere less legible.
  expect(high.length, "expected two high findings to assign roles to").toBe(2);
  expect(rest.length, "expected three non-high findings to assign roles to").toBe(3);

  const [suppressedOnly, baselinedOnly] = high as [Finding, Finding];
  const [both, ...neither] = rest as [Finding, ...Finding[]];

  writeFileSync(
    join(dir, "suppressions.json"),
    JSON.stringify({
      schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
      entries: [
        {
          fingerprint: suppressedOnly.fingerprint,
          reason: "Consent is collected on the prior step.",
        },
        { fingerprint: both.fingerprint, reason: "Stock count is live from inventory." },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "baseline.json"),
    JSON.stringify({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      toolVersion: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      note: "Accepted risk, not resolved risk.",
      entries: [
        { fingerprint: baselinedOnly.fingerprint, ruleId: baselinedOnly.ruleId },
        { fingerprint: both.fingerprint, ruleId: both.ruleId },
      ],
    }),
    "utf8",
  );

  return { target, suppressedOnly, baselinedOnly, both, neither };
}

const bothFlags = (roles: Roles, dir: string, ...extra: string[]) =>
  run(
    [
      "scan",
      roles.target,
      "--ignore-config",
      "--suppress",
      join(dir, "suppressions.json"),
      "--baseline",
      join(dir, "baseline.json"),
      ...extra,
    ],
    dir,
  );

describe("fairux scan --suppress with --baseline", () => {
  it("does not bring back a finding the suppression file removed", () => {
    // The defect this file was written for: the baseline was applied to the report as scanned
    // rather than to the report the suppressions had already subtracted from, so a finding named
    // only by the suppression file reappeared in everything downstream of it.
    withTempDir("fairux-both-revive-", (dir) => {
      const roles = setUp(dir);
      const result = bothFlags(roles, dir, "--format", "json");
      const reported: Finding[] = JSON.parse(result.stdout).findings;
      const fingerprints = reported.map((finding) => finding.fingerprint);

      expect(fingerprints).not.toContain(roles.suppressedOnly.fingerprint);
      expect(fingerprints).not.toContain(roles.baselinedOnly.fingerprint);
      expect(fingerprints).not.toContain(roles.both.fingerprint);
      expect(fingerprints.sort()).toEqual(roles.neither.map((f) => f.fingerprint).sort());
    });
  });

  it("keeps the summary equal to the findings it kept", () => {
    // A summary counting findings the report no longer carries is what makes a revived finding hard
    // to see: the count is what a pipeline reads.
    withTempDir("fairux-both-summary-", (dir) => {
      const roles = setUp(dir);
      const report = JSON.parse(bothFlags(roles, dir, "--format", "json").stdout);
      expect(report.summary.total).toBe(roles.neither.length);
      expect(report.findings).toHaveLength(report.summary.total);
      expect(report.summary.bySeverity.high).toBe(0);
    });
  });

  it("charges an overlapping finding to the suppression without calling it stale", () => {
    // The reason a suppression carries is what a reader needs and a baseline has none, so the
    // overlap is the suppression's: the baseline counts one, not two.
    //
    // And it is counted nowhere else. A suppressed finding is hidden, not gone — the scan still
    // reports it — so an entry covering it is not one the baseline can drop. Advising that would
    // send a reader to delete the only record of an accepted risk, leaving it held up by a
    // suppression that expires.
    withTempDir("fairux-both-overlap-", (dir) => {
      const roles = setUp(dir);
      const { stderr } = bothFlags(roles, dir, "--format", "json");
      expect(stderr).toContain("Stock count is live from inventory.");
      expect(stderr).toContain("suppressed 1 finding(s)");
      expect(stderr).not.toContain("no longer appear");
    });
  });

  it("still names a baseline entry the scan has stopped finding", () => {
    // The other half of the same claim: the check above must not be passing because the message was
    // turned off. An entry matching nothing in the scan is stale, whatever the suppressions did.
    withTempDir("fairux-both-stale-", (dir) => {
      const roles = setUp(dir);
      const baselinePath = join(dir, "baseline.json");
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      baseline.entries.push({
        fingerprint: "0000000000000000",
        ruleId: "scarcity/scarcity-phrase",
      });
      writeFileSync(baselinePath, JSON.stringify(baseline), "utf8");

      const { stderr } = bothFlags(roles, dir, "--format", "json");
      // One, not two: the fabricated entry, and not the overlap beside it.
      expect(stderr).toContain("1 baselined finding(s) no longer appear");
    });
  });

  it("fails the build on neither file's findings", () => {
    // Both `high` findings are covered, one by each file. An exit code of 1 here means one of them
    // reached the threshold, which it can only do by surviving a subtraction that named it.
    withTempDir("fairux-both-failon-", (dir) => {
      const roles = setUp(dir);
      expect(run(["scan", roles.target, "--ignore-config", "--fail-on", "high"], dir).status).toBe(
        1,
      );
      expect(bothFlags(roles, dir, "--fail-on", "high").status).toBe(0);
    });
  });

  it("scores the risk index on what it reported, not on what it scanned", () => {
    withTempDir("fairux-both-risk-", (dir) => {
      const roles = setUp(dir);
      const indexPath = join(dir, "risk-index.json");
      bothFlags(roles, dir, "--format", "json", "--risk-index", indexPath);
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      const scored: string[] = index.contributingFindings.map(
        (finding: { fingerprint: string }) => finding.fingerprint,
      );
      // Equality, not two absences: naming what must be gone leaves whatever was not named
      // unchecked, and the claim in the title is that this set and the reported set are the same
      // set.
      expect(scored.sort()).toEqual(roles.neither.map((finding) => finding.fingerprint).sort());
    });
  });

  it("reports the same findings in every format", () => {
    // Four renderers read one filtered report, and a reader comparing two of them should not be
    // able to tell which subtraction ran. Markdown and HTML carry no fingerprints, so they are
    // checked on the rule that only the revived finding would introduce.
    withTempDir("fairux-both-formats-", (dir) => {
      const roles = setUp(dir);
      const revivedRule = roles.suppressedOnly.ruleId;

      const json = JSON.parse(bothFlags(roles, dir, "--format", "json").stdout);
      expect(json.findings.map((f: Finding) => f.ruleId)).not.toContain(revivedRule);

      const sarif = bothFlags(roles, dir, "--format", "sarif").stdout;
      expect(sarif).not.toContain(roles.suppressedOnly.fingerprint);
      expect(JSON.parse(sarif).runs[0].results).toHaveLength(roles.neither.length);

      for (const format of ["markdown", "html"] as const) {
        const rendered = bothFlags(roles, dir, "--format", format).stdout;
        expect(rendered, format).not.toContain(revivedRule);
      }
    });
  });

  it("leaves each flag's behaviour alone when it is the only one given", () => {
    // Each flag alone is the established behaviour, and it runs through the same code the combined
    // path does — so it is asserted here rather than assumed.
    withTempDir("fairux-both-single-", (dir) => {
      const roles = setUp(dir);
      const suppressOnly = run(
        [
          "scan",
          roles.target,
          "--format",
          "json",
          "--ignore-config",
          "--suppress",
          join(dir, "suppressions.json"),
        ],
        dir,
      );
      const afterSuppress = JSON.parse(suppressOnly.stdout).findings.map(
        (f: Finding) => f.fingerprint,
      );
      expect(afterSuppress).toContain(roles.baselinedOnly.fingerprint);
      expect(afterSuppress).not.toContain(roles.suppressedOnly.fingerprint);

      const baselineOnly = run(
        [
          "scan",
          roles.target,
          "--format",
          "json",
          "--ignore-config",
          "--baseline",
          join(dir, "baseline.json"),
        ],
        dir,
      );
      const afterBaseline = JSON.parse(baselineOnly.stdout).findings.map(
        (f: Finding) => f.fingerprint,
      );
      expect(afterBaseline).toContain(roles.suppressedOnly.fingerprint);
      expect(afterBaseline).not.toContain(roles.baselinedOnly.fingerprint);
    });
  });

  it("currently lets --write-baseline ignore both flags rather than refusing them", () => {
    // A record of what happens today, not an endorsement of it. `--write-baseline` records the scan
    // and returns before either subtraction, so a command line carrying all three is accepted, acts
    // on one of them, and exits 0. Whether that should be refused outright belongs to the option
    // compatibility work; this is here so that change is visible as a change rather than arriving
    // through a test nobody had written.
    withTempDir("fairux-both-write-", (dir) => {
      const roles = setUp(dir);
      const written = join(dir, "written.json");
      const result = bothFlags(roles, dir, "--write-baseline", written);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("");
      expect(JSON.parse(readFileSync(written, "utf8")).entries).toHaveLength(5);
    });
  });
});
