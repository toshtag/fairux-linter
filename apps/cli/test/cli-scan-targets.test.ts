import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxBatchReport, FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_FILES } from "../src/scan-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

function runCli(args: string[], opts?: { stdin?: string; cwd?: string }): string {
  return execFileSync("node", [cliBin, ...args], {
    encoding: "utf8",
    input: opts?.stdin,
    cwd: opts?.cwd,
    timeout: 10000,
  });
}

function runCliResult(args: string[], opts?: { stdin?: string; cwd?: string }) {
  return spawnSync("node", [cliBin, ...args], {
    encoding: "utf8",
    input: opts?.stdin,
    cwd: opts?.cwd,
    timeout: 10000,
  });
}

describe("CLI directory scanning", () => {
  it("scans a directory recursively and outputs JSON", () => {
    const dir = resolve(here, "../../../examples");
    const output = runCli(["scan", dir, "--format", "json", "--ignore-config"]);
    const report = JSON.parse(output) as FairUxBatchReport;
    expect(report.summary.total).toBeGreaterThan(0);
    const ids = report.reports.flatMap((r) => r.findings).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(report.inputs.map((input) => input.file)).toEqual(
      report.reports.map((subReport) => subReport.input.file),
    );
  });

  it("renders directory batch Markdown through the shared reporter", () => {
    const dir = resolve(here, "../../../examples");
    const output = runCli(["scan", dir, "--format", "markdown", "--ignore-config"]);
    expect(output).toContain("FairUX does not provide legal judgments");
    expect(output).toContain("# FairUX Batch Report");
  });

  it("renders directory batch SARIF through the shared reporter", () => {
    const dir = resolve(here, "../../../examples");
    const output = runCli(["scan", dir, "--format", "sarif", "--ignore-config"]);
    const sarif = JSON.parse(output);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
    expect(sarif.runs[0].results[0].fingerprints.fairuxV1).toBeDefined();
    expect(sarif.runs[0].results[0].partialFingerprints).toBeUndefined();
  });

  it("reports directory batch file limits without node wording", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-dir-limit-"));
    try {
      for (let i = 0; i <= MAX_BATCH_FILES; i++) {
        writeFileSync(join(tmp, `${String(i).padStart(3, "0")}.html`), "<p>Hello</p>", "utf8");
      }
      const res = runCliResult(["scan", tmp, "--format", "json", "--ignore-config"]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("batch exceeds files limit");
      expect(res.stderr).toContain(`${MAX_BATCH_FILES + 1} files`);
      expect(res.stderr).not.toMatch(/nodes/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("CLI stdin scanning", () => {
  it("scans HTML from stdin with '-' path", () => {
    const html =
      '<html><body><h1>Privacy Settings</h1><form><input type="checkbox" checked> I agree to receive marketing emails</form></body></html>';
    const output = runCli(["scan", "-", "--format", "json", "--ignore-config"], {
      stdin: html,
    });
    const report = JSON.parse(output) as FairUxReport;
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.ruleId === "consent/checked-checkbox")).toBe(true);
  });
});

describe("CLI --fail-on", () => {
  it("exits with code 1 when high findings meet --fail-on high", () => {
    const dir = resolve(here, "../../../examples");
    expect(() => {
      execFileSync(
        "node",
        [cliBin, "scan", dir, "--format", "json", "--fail-on", "high", "--ignore-config"],
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    }).toThrow();
  });

  it("exits with code 0 when --fail-on info and no info findings", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-test-"));
    writeFileSync(join(tmp, "empty.html"), "<p>hello</p>");
    const output = runCli([
      "scan",
      tmp,
      "--format",
      "json",
      "--fail-on",
      "info",
      "--ignore-config",
    ]);
    const report = JSON.parse(output) as FairUxReport;
    expect(report.findings.length).toBe(0);
  });
});

describe("CLI glob scanning", () => {
  it("scans files matching a glob pattern", () => {
    const examplesDir = resolve(here, "../../../examples");
    const pattern = join(examplesDir, "*.html");
    const output = runCli(["scan", pattern, "--format", "json", "--ignore-config"]);
    const report = JSON.parse(output) as FairUxBatchReport;
    expect(report.reports.length).toBeGreaterThan(0);
    expect(report.summary.total).toBeGreaterThan(0);
  });

  it("renders glob batch Markdown and SARIF through the shared reporter", () => {
    const examplesDir = resolve(here, "../../../examples");
    const pattern = join(examplesDir, "*.html");
    const markdown = runCli(["scan", pattern, "--format", "markdown", "--ignore-config"]);
    expect(markdown).toContain("FairUX does not provide legal judgments");

    const sarif = JSON.parse(runCli(["scan", pattern, "--format", "sarif", "--ignore-config"]));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0].fingerprints.fairuxV1).toBeDefined();
  });

  it("scans a relative glob with config auto-discovery enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-config-"));
    try {
      const pages = join(tmp, "pages");
      mkdirSync(pages);
      writeFileSync(join(tmp, "package.json"), '{"name":"fixture"}', "utf8");
      writeFileSync(
        join(tmp, "fairux.config.json"),
        JSON.stringify({ rules: { "consent/checked-checkbox": { severity: "low" } } }),
        "utf8",
      );
      writeFileSync(
        join(pages, "consent.html"),
        '<html><body><label><input type="checkbox" checked> Email me offers</label></body></html>',
        "utf8",
      );
      writeFileSync(join(pages, "clean.html"), "<p>Hello</p>", "utf8");

      const output = runCli(["scan", "pages/**/*.html", "--format", "json"], { cwd: tmp });
      const report = JSON.parse(output) as FairUxBatchReport;
      const finding = report.reports
        .flatMap((r) => r.findings)
        .find((f) => f.ruleId === "consent/checked-checkbox");
      expect(finding?.severity).toBe("low");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scans an absolute glob deterministically with config auto-discovery enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-absolute-"));
    try {
      const pages = join(tmp, "pages");
      mkdirSync(pages);
      writeFileSync(join(pages, "fairux.config.json"), "{}", "utf8");
      writeFileSync(join(pages, "b.html"), "<button>Buy now</button>", "utf8");
      writeFileSync(join(pages, "a.html"), "<button>Buy now</button>", "utf8");

      const output = runCli(["scan", join(pages, "*.html"), "--format", "json"], { cwd: tmp });
      const report = JSON.parse(output) as FairUxBatchReport;
      expect(report.inputs.map((input) => input.file?.split("/").pop())).toEqual([
        "a.html",
        "b.html",
      ]);
      expect(report.inputs.map((input) => input.file)).toEqual(
        report.reports.map((subReport) => subReport.input.file),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses portable report paths for direct files and single-match globs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-single-paths-"));
    try {
      const page = join(tmp, "page.html");
      writeFileSync(page, "<button>Buy now</button>", "utf8");

      const direct = JSON.parse(
        runCli(["scan", page, "--format", "json", "--ignore-config"]),
      ) as FairUxReport;
      expect(direct.input.file).toBe(relative(process.cwd(), page));
      expect(isAbsolute(direct.input.file ?? "")).toBe(false);

      const glob = JSON.parse(
        runCli(["scan", join(tmp, "*.html"), "--format", "json", "--ignore-config"]),
      ) as FairUxReport;
      expect(glob.kind).toBe("single");
      expect(glob.input.file).toContain("page.html");
      expect(isAbsolute(glob.input.file ?? "")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats existing paths with glob magic as literal targets", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-literal-glob-"));
    try {
      writeFileSync(join(tmp, "fairux.config.json"), "{}", "utf8");
      const html = join(tmp, "page[1].html");
      const tsx = join(tmp, "pricing{legacy}.tsx");
      writeFileSync(html, "<button>Buy now</button>", "utf8");
      writeFileSync(tsx, `export const Pricing = () => <button>Buy now</button>;`, "utf8");
      writeFileSync(join(tmp, "page1.html"), "<p>Different</p>", "utf8");

      const htmlReport = JSON.parse(
        runCli(["scan", "page[1].html", "--format", "json"], { cwd: tmp }),
      ) as FairUxReport;
      expect(htmlReport.kind).toBe("single");
      expect(htmlReport.input.file).toBe("page[1].html");

      const tsxReport = JSON.parse(
        runCli(["scan", "pricing{legacy}.tsx", "--format", "json"], { cwd: tmp }),
      ) as FairUxReport;
      expect(tsxReport.kind).toBe("single");
      expect(tsxReport.input.file).toBe("pricing{legacy}.tsx");
      expect(tsxReport.input.runtime).toBe("ast");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed config discovered from a glob base", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-bad-config-"));
    try {
      const pages = join(tmp, "pages");
      mkdirSync(pages);
      writeFileSync(join(pages, "fairux.config.json"), "{ invalid json", "utf8");
      writeFileSync(join(pages, "page.html"), "<button>Buy now</button>", "utf8");

      const res = runCliResult(["scan", "pages/**/*.html", "--format", "json"], { cwd: tmp });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("config error");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports no scannable files for a no-match glob instead of statting the literal pattern", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-no-match-"));
    try {
      mkdirSync(join(tmp, "pages"));
      const res = runCliResult(["scan", "pages/**/*.html", "--format", "json"], { cwd: tmp });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("no scannable files found");
      expect(res.stderr).not.toContain("ENOENT");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // A glob's separator is the platform's, and the shell settles none of it: on Windows neither
  // `cmd.exe` nor PowerShell expands a pattern, so whatever the user typed reaches the CLI. Both
  // branches below are real cases on the platform they run on; the pure rules behind them are
  // settled from any host in `glob-target.test.ts`.
  //
  // Where each branch actually executes: this file is not in the Windows CI job, which runs only
  // the platform-specific unit files and then the packed smoke. So the Windows branch runs for a
  // developer on Windows, and CI's Windows execution of the same three cases comes from
  // `installed-cli-smoke-contract.mjs`, against the installed CLI. The POSIX branch runs in
  // `verify`.
  if (process.platform === "win32") {
    it("scans a relative native-separator glob on Windows", () => {
      const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-native-"));
      try {
        mkdirSync(join(tmp, "inputs"));
        writeFileSync(join(tmp, "inputs", "a.html"), "<button>Buy now</button>", "utf8");
        writeFileSync(join(tmp, "inputs", "b.html"), "<button>Buy now</button>", "utf8");

        const native = JSON.parse(
          runCli(["scan", "inputs\\*.html", "--format", "json", "--ignore-config"], { cwd: tmp }),
        ) as FairUxBatchReport;
        const portable = JSON.parse(
          runCli(["scan", "inputs/*.html", "--format", "json", "--ignore-config"], { cwd: tmp }),
        ) as FairUxBatchReport;

        expect(native.inputs.map((input) => input.file)).toEqual([
          "inputs/a.html",
          "inputs/b.html",
        ]);
        expect(native.inputs).toEqual(portable.inputs);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("scans a drive-absolute native-separator glob on Windows", () => {
      const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-native-abs-"));
      try {
        writeFileSync(join(tmp, "page.html"), "<button>Buy now</button>", "utf8");

        // `join` produces the native form here on purpose — it is what a Windows user types.
        const report = JSON.parse(
          runCli(["scan", join(tmp, "*.html"), "--format", "json", "--ignore-config"]),
        ) as FairUxReport;
        expect(report.kind).toBe("single");
        expect(report.input.file).toContain("page.html");
        expect(report.input.file).not.toContain("\\");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("refuses a UNC glob distinguishably from a glob that matches nothing", () => {
      // No share is contacted: the refusal is decided from the pattern's form, which is why this
      // case is deterministic on a runner with no network drive.
      const res = runCliResult([
        "scan",
        "\\\\server\\share\\*.html",
        "--format",
        "json",
        "--ignore-config",
      ]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("not supported for UNC");
      expect(res.stderr).not.toContain("no scannable files found");
    });
  } else {
    it("keeps a backslash escaping glob magic off Windows", () => {
      const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-escape-"));
      try {
        writeFileSync(join(tmp, "a*.html"), "<button>Buy now</button>", "utf8");
        writeFileSync(join(tmp, "ab.html"), "<button>Buy now</button>", "utf8");

        const escaped = JSON.parse(
          runCli(["scan", "a\\*.html", "--format", "json", "--ignore-config"], { cwd: tmp }),
        ) as FairUxReport;
        expect(escaped.kind).toBe("single");
        expect(escaped.input.file).toContain("a*.html");

        // The contrast is an unescaped `*`, not the same pattern without the backslash: `a*.html`
        // is itself an existing file here, and an existing path keeps its literal meaning.
        const unescaped = JSON.parse(
          runCli(["scan", "*.html", "--format", "json", "--ignore-config"], { cwd: tmp }),
        ) as FairUxBatchReport;
        expect(unescaped.kind).toBe("batch");
        expect(unescaped.inputs.map((input) => input.file?.endsWith("ab.html"))).toContain(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("treats a leading // as an ordinary absolute path rather than a UNC refusal", () => {
      const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-double-slash-"));
      try {
        writeFileSync(join(tmp, "page.html"), "<button>Buy now</button>", "utf8");

        const res = runCliResult([
          "scan",
          `/${join(tmp, "*.html")}`,
          "--format",
          "json",
          "--ignore-config",
        ]);
        expect(res.status).toBe(0);
        expect((JSON.parse(res.stdout) as FairUxReport).input.file).toContain("page.html");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

describe("CLI Figma scanning", () => {
  it("scans a .figjson file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-figma-"));
    const figmaJson = JSON.stringify({
      document: {
        id: "0:0",
        name: "Page",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Button/Buy",
            type: "COMPONENT",
            componentPropertyDefinitions: {
              Label: { type: "TEXT", defaultValue: "Buy now" },
            },
            children: [{ id: "1:2", name: "Label", type: "TEXT", characters: "Buy now" }],
          },
        ],
      },
      name: "Test Figma",
    });
    const filePath = join(tmp, "test.figjson");
    writeFileSync(filePath, figmaJson);
    const output = runCli(["scan", filePath, "--format", "json", "--ignore-config"]);
    const report = JSON.parse(output) as FairUxReport;
    expect(report.input.runtime).toBe("figma");
  });
});
