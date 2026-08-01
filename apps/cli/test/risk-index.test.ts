import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RiskIndexReport } from "@fairux/core";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

const DIRTY = `<!doctype html><html lang="en"><head><title>Consent</title></head><body><main>
  <form><label><input type="checkbox" name="marketing" checked> Email me product offers</label>
  <button type="submit">Save</button><button type="button">Reject all</button></form>
</main></body></html>`;

/** Its only finding is low severity, which is what makes the exit-code test below meaningful. */
const LOW = `<!doctype html><html lang="en"><head><title>Wireless mouse</title></head><body><main>
  <h1>Wireless mouse</h1><p class="stock">Only 2 left in stock!</p>
</main></body></html>`;

const CLEAN = `<!doctype html><html lang="en"><head><title>About us</title></head><body><main>
  <h1>About us</h1><p>We build tools for small design teams.</p>
</main></body></html>`;

function withProject<T>(files: Record<string, string>, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-risk-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents, "utf8");
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args: string[], cwd: string) {
  return spawnSync("node", [cliBin, ...args], { encoding: "utf8", cwd, timeout: 15000 });
}

function readIndex(dir: string, name = "index.json"): RiskIndexReport {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as RiskIndexReport;
}

describe("fairux scan --risk-index", () => {
  it("changes nothing about stdout", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      const without = execFileSync("node", [cliBin, "scan", "page.html", "--format", "json"], {
        encoding: "utf8",
        cwd: dir,
      });
      const withFlag = cli(
        ["scan", "page.html", "--format", "json", "--risk-index", "index.json"],
        dir,
      );
      // Byte for byte, apart from the timestamp every report carries. A score appearing in the
      // output a pipeline already parses would arrive in every pipeline.
      const mask = (text: string) =>
        text.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "MASKED"');
      expect(mask(withFlag.stdout)).toBe(mask(without));
      expect(withFlag.stdout).not.toContain("riskIndex");
      expect(withFlag.stdout).not.toContain("risk-index");
    });
  });

  it("writes the index where it was asked to, and nowhere otherwise", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      cli(["scan", "page.html", "--risk-index", "index.json"], dir);
      const index = readIndex(dir);
      expect(index.kind).toBe("risk-index");
      expect(index.versions.modelVersion).toBe("fairux-risk/1");
      expect(index.status).toBe("sufficient");
      expect(index.score).toBeGreaterThan(0);
    });
    withProject({ "page.html": DIRTY }, (dir) => {
      cli(["scan", "page.html"], dir);
      expect(existsSync(join(dir, "index.json"))).toBe(false);
    });
  });

  it("says what the number is not, in the same breath as the number", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      const result = cli(["scan", "page.html", "--risk-index", "index.json"], dir);
      expect(result.stderr).toContain("risk index 20");
      expect(result.stderr).toContain("model fairux-risk/1");
      expect(result.stderr).toContain("not a safety, legal, or compliance verdict");
      expect(result.stderr).toContain("does not affect this command's exit code");
    });
  });

  it("scores zero on a clean page, and still says nothing about safety", () => {
    withProject({ "page.html": CLEAN }, (dir) => {
      const result = cli(["scan", "page.html", "--risk-index", "index.json"], dir);
      expect(readIndex(dir).score).toBe(0);
      expect(result.stderr).toContain("not a safety, legal, or compliance verdict");
    });
  });

  it("describes what the scan reported, after a baseline subtracted its accepted risk", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      cli(["scan", "page.html", "--write-baseline", "baseline.json"], dir);
      cli(["scan", "page.html", "--baseline", "baseline.json", "--risk-index", "index.json"], dir);
      // Everything is baselined, so the report is empty and so is the number. A score computed
      // before the subtraction would describe findings the report does not show.
      expect(readIndex(dir).score).toBe(0);
      expect(readIndex(dir).contributingFindings).toEqual([]);
    });
  });

  it("covers a directory scan, counting every input", () => {
    withProject({ "a.html": DIRTY, "b.html": CLEAN }, (dir) => {
      cli(["scan", ".", "--risk-index", "index.json"], dir);
      const index = readIndex(dir);
      expect(index.coverage.documents).toBe(2);
      // The worst single input decides the score, so a clean page beside a bad one does not dilute
      // it — which is the model's documented aggregation, not something the CLI re-decides.
      expect(index.score).toBeGreaterThan(0);
    });
  });
});

/**
 * The guard that replaced the source-level one in `tests/unit/risk-index-exit-code-contract.test.ts`.
 *
 * That test failed the moment the CLI read a Risk Index, on purpose: whoever wired it up had to
 * decide the exit-code question rather than inherit it. The decision is the one this repository had
 * already written down — a build goes red because of what was found, never because a number crossed
 * a line — and this is what proves it, behaviourally.
 */
describe("the exit code ignores the score", () => {
  it("is 0 for a page that scores, with no --fail-on", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      const result = cli(["scan", "page.html", "--risk-index", "index.json"], dir);
      expect(readIndex(dir).score).toBeGreaterThan(0);
      expect(result.status).toBe(0);
    });
  });

  it("is decided by --fail-on and the findings, with or without the flag", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      const withIndex = cli(
        ["scan", "page.html", "--fail-on", "medium", "--risk-index", "index.json"],
        dir,
      );
      const withoutIndex = cli(["scan", "page.html", "--fail-on", "medium"], dir);
      expect(withIndex.status).toBe(1);
      expect(withoutIndex.status).toBe(withIndex.status);
    });
  });

  it("is 0 for a page that scores while no --fail-on threshold catches its findings", () => {
    withProject({ "page.html": LOW }, (dir) => {
      // The page scores, and its only finding is low severity, so a `high` threshold does not fire.
      // If the score influenced the exit code at all, this is where it would show.
      const result = cli(
        ["scan", "page.html", "--fail-on", "high", "--risk-index", "index.json"],
        dir,
      );
      expect(readIndex(dir).score).toBeGreaterThan(0);
      expect(result.status).toBe(0);
    });
  });

  it("offers no flag that would gate the exit code on a score", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      const help = cli(["scan", "--help"], dir);
      expect(help.stdout).toContain("--risk-index");
      expect(help.stdout).toContain("never changes stdout or the exit code");
      expect(help.stdout).not.toMatch(/--fail-on-score|--min-score|--max-risk/);
    });
  });
});
