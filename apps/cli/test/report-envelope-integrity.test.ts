import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxBatchReport, FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";

/**
 * What a report must still say once the target is a directory, or the format is not JSON.
 *
 * An inline `fairux-disable-next-line` removes a finding inside `scan()`, so it never reaches
 * `findings`. The report records it in `suppressed`, with the reason its author had to write, and
 * records a directive that matched nothing in `suppressionDiagnostics`. Both exist because of a
 * boundary this project states in several places: a suppression nobody can see is a rule that was
 * silently turned off, and a directive that suppressed nothing while its author believed otherwise
 * is the worse of the two failures.
 *
 * Two paths lost that record, and each of them is one a user reaches by doing something ordinary.
 *
 * - **Scanning a directory.** The batch envelope was assembled by copying `input`, `summary`,
 *   `coverage`, and `findings` out of each single report and nothing else. `fairux scan page.html`
 *   said a rule had been turned off on line 4; `fairux scan .` did not.
 * - **Asking for anything but JSON.** Markdown, HTML, and SARIF read `findings` and stopped. The
 *   two surfaces a person actually reads rendered a page with a directive exactly like a page
 *   without one.
 *
 * Everything here drives the built CLI, because the claim is about what a user is shown.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const FIGMA = resolve(here, "../../../tests/fixtures/sarif-canary/design.figjson");

/** One directive that applies, and one that names a rule no finding has. */
const SUPPRESSED_PAGE = [
  "<main>",
  "  <h1>Cookie consent</h1>",
  "  <!-- fairux-disable-next-line consent/checked-checkbox -- agreed on the prior step -->",
  '  <label><input type="checkbox" checked> Email me marketing offers</label>',
  "  <!-- fairux-disable-next-line no/such-rule -- a typo nobody noticed -->",
  "  <p>Only 2 left in stock!</p>",
  "</main>",
  "",
].join("\n");

const PLAIN_PAGE = "<main><p>Only 2 left in stock!</p></main>\n";

function withProject<T>(files: Record<string, string>, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-envelope-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents, "utf8");
    }
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cli = (args: string[], cwd: string) =>
  spawnSync("node", [cliBin, ...args, "--ignore-config"], {
    encoding: "utf8",
    cwd,
    timeout: 30000,
  });

const scanJson = <T>(args: string[], cwd: string): T =>
  JSON.parse(cli([...args, "--format", "json"], cwd).stdout) as T;

describe("a batch report carries what a single report carries", () => {
  it("keeps the inline suppressions and their reasons", () => {
    withProject({ "a.html": SUPPRESSED_PAGE, "b.html": PLAIN_PAGE }, (dir) => {
      const single = scanJson<FairUxReport>(["scan", "a.html"], dir);
      const batch = scanJson<FairUxBatchReport>(["scan", "."], dir);
      const sub = batch.reports.find((report) => report.input.file === "a.html");

      // The same record, not a rolled-up count: a reason belongs to the line it was written on.
      expect(single.suppressed).toHaveLength(1);
      expect(sub?.suppressed).toEqual(single.suppressed);
      expect(sub?.suppressed?.[0]?.reason).toBe("agreed on the prior step");
    });
  });

  it("keeps the diagnostics for a directive that matched nothing", () => {
    withProject({ "a.html": SUPPRESSED_PAGE, "b.html": PLAIN_PAGE }, (dir) => {
      const single = scanJson<FairUxReport>(["scan", "a.html"], dir);
      const batch = scanJson<FairUxBatchReport>(["scan", "."], dir);
      const sub = batch.reports.find((report) => report.input.file === "a.html");

      expect(single.suppressionDiagnostics).toHaveLength(1);
      expect(sub?.suppressionDiagnostics).toEqual(single.suppressionDiagnostics);
    });
  });

  it("omits them for an input that has none, exactly as a single report does", () => {
    // Additive, not invented: a sub-report with no directive gains no empty arrays.
    withProject({ "a.html": SUPPRESSED_PAGE, "b.html": PLAIN_PAGE }, (dir) => {
      const batch = scanJson<FairUxBatchReport>(["scan", "."], dir);
      const plain = batch.reports.find((report) => report.input.file === "b.html");
      expect(plain).toBeDefined();
      expect(Object.hasOwn(plain as object, "suppressed")).toBe(false);
      expect(Object.hasOwn(plain as object, "suppressionDiagnostics")).toBe(false);
    });
  });

  it("gives each sub-report the same input shape the top-level inputs carry", () => {
    // `inputs[]` and `reports[].input` describe the same input. A reader should not have to index
    // one against the other to learn which runtime a Figma export was scanned under.
    withProject({ "a.html": PLAIN_PAGE, "b.figjson": readFileSync(FIGMA, "utf8") }, (dir) => {
      const batch = scanJson<FairUxBatchReport>(["scan", "."], dir);
      expect(batch.reports.map((report) => report.input)).toEqual(batch.inputs);
      expect(batch.inputs.some((input) => input.runtime === "figma")).toBe(true);
    });
  });
});

describe("a filter does not erase the per-runtime breakdown", () => {
  /**
   * `--suppress` and `--baseline` both recompute the summary so it agrees with the findings left.
   * Both recomputed `{ total, bySeverity }` — the whole of a *single* report's summary and not the
   * whole of a batch's, which also carries `byRuntime`. So a field present in
   * `fairux scan . --format json` vanished from `fairux scan . --format json --suppress s.json`,
   * in the report a pipeline reads.
   */
  const setUp = (dir: string) => {
    writeFileSync(join(dir, "a.html"), SUPPRESSED_PAGE, "utf8");
    writeFileSync(join(dir, "b.figjson"), readFileSync(FIGMA, "utf8"), "utf8");
    const before = scanJson<FairUxBatchReport>(["scan", "."], dir);
    const figma = before.reports
      .filter((report) => report.input.runtime === "figma")
      .flatMap((report) => report.findings);
    return { before, figmaFingerprint: figma[0]?.fingerprint as string };
  };

  it("keeps byRuntime through --suppress", () => {
    withProject({}, (dir) => {
      const { before, figmaFingerprint } = setUp(dir);
      expect(before.summary.byRuntime).toBeDefined();
      writeFileSync(
        join(dir, "s.json"),
        JSON.stringify({
          schemaVersion: "1",
          entries: [{ fingerprint: figmaFingerprint, reason: "accepted in the design system" }],
        }),
        "utf8",
      );

      const after = scanJson<FairUxBatchReport>(["scan", ".", "--suppress", "s.json"], dir);
      expect(after.summary.byRuntime).toBeDefined();
      // The emptied runtime stays in the map at zero. Dropping the key would read as "this batch
      // had no Figma input", which is a different statement from "every Figma finding was accepted".
      expect(after.summary.byRuntime?.figma).toEqual({
        total: 0,
        bySeverity: { info: 0, low: 0, medium: 0, high: 0 },
      });
      expect(after.summary.byRuntime?.html).toEqual(before.summary.byRuntime?.html);
    });
  });

  it("keeps byRuntime through --baseline", () => {
    withProject({}, (dir) => {
      const { figmaFingerprint } = setUp(dir);
      writeFileSync(
        join(dir, "base.json"),
        JSON.stringify({
          schemaVersion: "1",
          note: "Accepted risk, not resolved risk.",
          toolVersion: "test",
          createdAt: "2026-01-01T00:00:00.000Z",
          entries: [{ fingerprint: figmaFingerprint, ruleId: "consent/checked-checkbox" }],
        }),
        "utf8",
      );

      const after = scanJson<FairUxBatchReport>(["scan", ".", "--baseline", "base.json"], dir);
      expect(after.summary.byRuntime).toBeDefined();
      expect(after.summary.byRuntime?.figma?.total).toBe(0);
    });
  });

  it("keeps the summary agreeing with the findings it describes", () => {
    // The property the recount exists for, unchanged by carrying byRuntime with it.
    withProject({}, (dir) => {
      const { figmaFingerprint } = setUp(dir);
      writeFileSync(
        join(dir, "s.json"),
        JSON.stringify({
          schemaVersion: "1",
          entries: [{ fingerprint: figmaFingerprint, reason: "accepted" }],
        }),
        "utf8",
      );
      const after = scanJson<FairUxBatchReport>(["scan", ".", "--suppress", "s.json"], dir);
      const counted = after.reports.reduce((total, report) => total + report.findings.length, 0);
      expect(after.summary.total).toBe(counted);
      const perRuntime = Object.values(after.summary.byRuntime ?? {}).reduce(
        (total, entry) => total + entry.total,
        0,
      );
      expect(perRuntime).toBe(counted);
    });
  });
});

describe("every surface shows what a directive did", () => {
  const shows = (output: string) => ({
    suppression: output.includes("agreed on the prior step"),
    diagnostic: output.includes("no/such-rule") || output.includes("remove it"),
  });

  for (const format of ["markdown", "html", "sarif"] as const) {
    it(`${format} names the suppressed rule, its reason, and the unused directive`, () => {
      withProject({ "a.html": SUPPRESSED_PAGE }, (dir) => {
        const output = cli(["scan", "a.html", "--format", format], dir).stdout;
        expect(shows(output).suppression, `${format} hides the reason`).toBe(true);
        expect(shows(output).diagnostic, `${format} hides the unused directive`).toBe(true);
      });
    });

    it(`${format} says nothing about suppressions when there were none`, () => {
      withProject({ "b.html": PLAIN_PAGE }, (dir) => {
        const output = cli(["scan", "b.html", "--format", format], dir).stdout;
        expect(output).not.toContain("inline directive");
        expect(output).not.toContain("Directive problems");
      });
    });

    it(`${format} shows it for a batch too`, () => {
      withProject({ "a.html": SUPPRESSED_PAGE, "b.html": PLAIN_PAGE }, (dir) => {
        const output = cli(["scan", ".", "--format", format], dir).stdout;
        expect(shows(output).suppression, `${format} batch hides the reason`).toBe(true);
      });
    });
  }

  it("shows it on a page whose findings were all suppressed", () => {
    // The case that matters most: a clean-looking report that is clean because a rule was turned
    // off. Markdown returns early on an empty findings list, and used to return before this.
    const allSuppressed = [
      "<main>",
      "  <h1>Cookie consent</h1>",
      "  <!-- fairux-disable-next-line consent/checked-checkbox -- accepted -->",
      '  <label><input type="checkbox" checked> Email me marketing offers</label>',
      "</main>",
      "",
    ].join("\n");
    withProject({ "a.html": allSuppressed }, (dir) => {
      const markdown = cli(["scan", "a.html", "--format", "markdown"], dir).stdout;
      expect(markdown).toContain("No findings.");
      expect(markdown).toContain("accepted");
      expect(markdown).toContain("Suppressed by an inline directive");
    });
  });

  it("escapes a reason on the HTML surface, where it is untrusted author text", () => {
    const injected = [
      "<main>",
      "  <h1>Cookie consent</h1>",
      "  <!-- fairux-disable-next-line consent/checked-checkbox -- <script>alert(1)</script> -->",
      '  <label><input type="checkbox" checked> Email me marketing offers</label>',
      "</main>",
      "",
    ].join("\n");
    withProject({ "a.html": injected }, (dir) => {
      const output = cli(["scan", "a.html", "--format", "html"], dir).stdout;
      expect(output).not.toContain("<script>alert(1)</script>");
      expect(output).toContain("&lt;script&gt;");
    });
  });
});
