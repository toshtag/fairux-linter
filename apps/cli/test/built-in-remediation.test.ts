import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { planFixes, writeFixes } from "../src/fix.js";
import { scanFileReport } from "../src/scan-file.js";

/**
 * The first built-in remediation, end to end through the real CLI.
 *
 * `--fix-dry-run` and `--fix-write` shipped with nothing to apply: only an external RulePack could
 * propose an edit, so the feature was a pipeline with no input and the plan said so in as many
 * words. `consent/checked-checkbox` now proposes one — deleting the `checked` attribute — and this
 * file is about the boundary of that claim rather than about the happy path alone.
 *
 * What makes it `safe` is that every input is exact and none of it is inferred: the range comes from
 * the parser, the expected text comes from the same read, and the checksum covers the bytes both
 * were computed against. Where any of that is missing there is **no remediation** — not a
 * `review-required` one, which would claim a fix exists and leave a reader to refuse it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

const PAGE = [
  "<main>",
  "  <h1>Cookie consent</h1>",
  '  <label><input type="checkbox" checked> Email me marketing offers</label>',
  "</main>",
  "",
].join("\n");

const FIXED = [
  "<main>",
  "  <h1>Cookie consent</h1>",
  '  <label><input type="checkbox"> Email me marketing offers</label>',
  "</main>",
  "",
].join("\n");

function withProject<T>(files: Record<string, string>, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-builtin-fix-"));
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
    timeout: 20000,
  });

const read = (dir: string, name = "page.html") => readFileSync(join(dir, name), "utf8");

describe("the remediation a scan reports", () => {
  it("carries an exact, safe, rule-origin edit", () => {
    withProject({ "page.html": PAGE }, (dir) => {
      const result = cli(["scan", "page.html", "--format", "json"], dir);
      const report = JSON.parse(result.stdout) as FairUxReport;
      const finding = report.findings.find((f) => f.ruleId === "consent/checked-checkbox");
      const remediation = finding?.remediation;

      expect(remediation).toBeDefined();
      expect(remediation?.safety).toBe("safe");
      expect(remediation?.origin).toBe("rule");
      expect(remediation?.file).toBe("page.html");
      expect(remediation?.fileChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(remediation?.edits).toHaveLength(1);
      // The whitespace before the attribute is part of the edit, or the fix leaves `checkbox" >`.
      expect(remediation?.edits[0]?.expected).toBe(" checked");
      expect(remediation?.edits[0]?.replacement).toBe("");
    });
  });

  it("proposes nothing for a JSX finding, where no range was recorded", () => {
    // The AST adapter reports source *locations*, not attribute ranges, so there is nothing to
    // build an edit from — and the answer is silence rather than a cautious fix.
    const tsx = [
      "export const C = () => (",
      "  <div>",
      "    <h1>Cookie consent</h1>",
      '    <label><input type="checkbox" checked /> Email me marketing offers</label>',
      "  </div>",
      ");",
      "",
    ].join("\n");
    withProject({ "page.tsx": tsx }, (dir) => {
      const report = JSON.parse(
        cli(["scan", "page.tsx", "--format", "json"], dir).stdout,
      ) as FairUxReport;
      const finding = report.findings.find((f) => f.ruleId === "consent/checked-checkbox");
      expect(finding, "the finding itself must survive").toBeDefined();
      expect(finding?.remediation).toBeUndefined();
    });
  });
});

describe("--fix-dry-run", () => {
  it("describes the edit and writes nothing", () => {
    withProject({ "page.html": PAGE }, (dir) => {
      const before = read(dir);
      const result = cli(["scan", "page.html", "--fix-dry-run"], dir);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("would apply consent/checked-checkbox:remove-checked");
      expect(result.stderr).toContain("pass --fix-write to apply these");
      expect(read(dir)).toBe(before);
    });
  });

  it("no longer says no built-in rule proposes one", () => {
    // The message the empty pipeline printed. It was true and is not.
    withProject({ "page.html": PAGE }, (dir) => {
      expect(cli(["scan", "page.html", "--fix-dry-run"], dir).stderr).not.toContain(
        "no built-in rule proposes one",
      );
    });
  });
});

describe("--fix-write", () => {
  it("removes the attribute and changes nothing else in the file", () => {
    withProject({ "page.html": PAGE }, (dir) => {
      const result = cli(["scan", "page.html", "--fix-write"], dir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("applied consent/checked-checkbox:remove-checked");
      // Byte equality, not a substring: the claim is that one attribute left and nothing moved.
      expect(read(dir)).toBe(FIXED);
    });
  });

  it("is idempotent — a second run has nothing to propose", () => {
    withProject({ "page.html": PAGE }, (dir) => {
      cli(["scan", "page.html", "--fix-write"], dir);
      const second = cli(["scan", "page.html", "--fix-write"], dir);

      expect(second.status).toBe(0);
      expect(second.stderr).toContain("nothing to apply");
      expect(read(dir)).toBe(FIXED);
    });
  });

  it("fixes each pre-checked box in a file with several", () => {
    const two = [
      "<main>",
      "  <h1>Cookie consent</h1>",
      '  <label><input type="checkbox" checked> Email me marketing offers</label>',
      '  <label><input type="checkbox" checked> Share my data with partners</label>',
      "</main>",
      "",
    ].join("\n");
    withProject({ "page.html": two }, (dir) => {
      cli(["scan", "page.html", "--fix-write"], dir);
      expect(read(dir)).not.toContain("checked");
      expect(read(dir).split("\n")).toHaveLength(two.split("\n").length);
    });
  });
});

describe("boolean-attribute spellings", () => {
  const spelling = (attribute: string) =>
    `<main>\n  <h1>Cookie consent</h1>\n  <label><input type="checkbox" ${attribute}> Email me marketing offers</label>\n</main>\n`;

  for (const attribute of ['checked=""', "checked=''", 'checked="checked"', "checked='checked'"]) {
    it(`removes ${attribute}`, () => {
      withProject({ "page.html": spelling(attribute) }, (dir) => {
        cli(["scan", "page.html", "--fix-write"], dir);
        expect(read(dir)).toBe(FIXED);
      });
    });
  }

  it("removes an uppercase CHECKED, which the parser lowercases and the range does not", () => {
    withProject({ "page.html": spelling("CHECKED") }, (dir) => {
      cli(["scan", "page.html", "--fix-write"], dir);
      expect(read(dir)).toBe(FIXED);
    });
  });

  it("proposes nothing for a value outside the supported set, and still reports the finding", () => {
    // `checked="yes"` is a pre-checked box: HTML says a boolean attribute is true when present,
    // whatever its value. It gets a finding and no fix, because the removable set is the one whose
    // meaning is beyond argument rather than the one a reading of the spec would allow.
    withProject({ "page.html": spelling('checked="yes"') }, (dir) => {
      const report = JSON.parse(
        cli(["scan", "page.html", "--format", "json"], dir).stdout,
      ) as FairUxReport;
      const finding = report.findings.find((f) => f.ruleId === "consent/checked-checkbox");
      expect(finding).toBeDefined();
      expect(finding?.remediation).toBeUndefined();

      const before = read(dir);
      cli(["scan", "page.html", "--fix-write"], dir);
      expect(read(dir)).toBe(before);
    });
  });
});

describe("line endings", () => {
  it("removes the attribute from a CRLF file without touching a single other line ending", () => {
    const crlf = PAGE.replaceAll("\n", "\r\n");
    withProject({ "page.html": crlf }, (dir) => {
      const result = cli(["scan", "page.html", "--fix-write"], dir);
      expect(result.status).toBe(0);
      expect(read(dir)).toBe(FIXED.replaceAll("\n", "\r\n"));
    });
  });

  it("removes an attribute that sits on its own line, with its leading newline", () => {
    const wrapped =
      "<main>\r\n" +
      "  <h1>Cookie consent</h1>\r\n" +
      "  <label><input\r\n" +
      '           type="checkbox"\r\n' +
      "           checked> Email me marketing offers</label>\r\n" +
      "</main>\r\n";
    withProject({ "page.html": wrapped }, (dir) => {
      cli(["scan", "page.html", "--fix-write"], dir);
      expect(read(dir)).toBe(
        "<main>\r\n" +
          "  <h1>Cookie consent</h1>\r\n" +
          "  <label><input\r\n" +
          '           type="checkbox"> Email me marketing offers</label>\r\n' +
          "</main>\r\n",
      );
    });
  });
});

describe("a file that moved under the fix", () => {
  it("refuses the edit when the file changed between the scan and the write", () => {
    // Not reachable through one CLI invocation — the scan and the write are the same process — so
    // the refusal is driven through the planner with a stale plan, which is exactly the state an
    // editor's save produces.
    withProject({ "page.html": PAGE }, (dir) => {
      const target = join(dir, "page.html");
      const report = scanFileReport(target, { format: "json", reportPath: target });
      const plan = planFixes(report);
      expect(plan.appliedCount).toBe(1);

      writeFileSync(target, "<main>SOMEONE ELSE WAS EDITING THIS</main>\n", "utf8");
      const outcome = writeFixes(plan);

      expect(outcome.ok).toBe(false);
      expect(outcome.written).toEqual([]);
      expect(outcome.stale[0]?.reason).toBe("checksum-changed");
      expect(readFileSync(target, "utf8")).toBe("<main>SOMEONE ELSE WAS EDITING THIS</main>\n");
    });
  });
});
