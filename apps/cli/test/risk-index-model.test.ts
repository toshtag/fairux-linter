import { spawnSync } from "node:child_process";
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

/**
 * A second model exists and the default does not move on its own.
 *
 * Two scores are comparable when their `modelVersion` matches and not otherwise, so the flag is how
 * `fairux-risk/2` is reached until a maintainer decides the default should change.
 */
describe("--risk-index-model", () => {
  const fivePages = {
    "a.html": DIRTY,
    "b.html": DIRTY,
    "c.html": DIRTY,
    "d.html": DIRTY,
    "e.html": DIRTY,
  };

  it("defaults to fairux-risk/1, and says so in the file it writes", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      cli(["scan", "page.html", "--risk-index", "index.json"], dir);
      expect(readIndex(dir).versions.modelVersion).toBe("fairux-risk/1");
    });
  });

  it("scores the same page identically under either model", () => {
    // One input, nothing to aggregate. If these differed, the breadth term would have leaked into
    // the case it is not about.
    withProject({ "page.html": DIRTY }, (dir) => {
      cli(["scan", "page.html", "--risk-index", "one.json"], dir);
      cli(
        ["scan", "page.html", "--risk-index", "two.json", "--risk-index-model", "fairux-risk/2"],
        dir,
      );
      expect(readIndex(dir, "two.json").score).toBe(readIndex(dir, "one.json").score);
      expect(readIndex(dir, "two.json").versions.modelVersion).toBe("fairux-risk/2");
    });
  });

  it("scores the same problem on five pages above the same problem on one", () => {
    withProject(fivePages, (dir) => {
      cli(["scan", ".", "--risk-index", "many.json", "--risk-index-model", "fairux-risk/2"], dir);
      const many = readIndex(dir, "many.json").score ?? 0;
      cli(
        ["scan", "a.html", "--risk-index", "one.json", "--risk-index-model", "fairux-risk/2"],
        dir,
      );
      const one = readIndex(dir, "one.json").score ?? 0;
      expect(many).toBeGreaterThan(one);
      // And the default still cannot tell them apart, which is the reason the second model exists.
      cli(["scan", ".", "--risk-index", "v1.json"], dir);
      cli(["scan", "a.html", "--risk-index", "v1one.json"], dir);
      expect(readIndex(dir, "v1.json").score).toBe(readIndex(dir, "v1one.json").score);
    });
  });

  it("refuses a model that does not exist, before scanning anything", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      const result = cli(
        ["scan", "page.html", "--risk-index", "index.json", "--risk-index-model", "fairux-risk/9"],
        dir,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unknown risk index model "fairux-risk/9"');
      expect(result.stderr).toContain("fairux-risk/1 or fairux-risk/2");
      expect(existsSync(join(dir, "index.json"))).toBe(false);
      expect(result.stdout).toBe("");
    });
  });

  it("leaves the exit code alone, whichever model scored it", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      const plain = cli(["scan", "page.html", "--fail-on", "medium"], dir);
      const scored = cli(
        [
          "scan",
          "page.html",
          "--fail-on",
          "medium",
          "--risk-index",
          "index.json",
          "--risk-index-model",
          "fairux-risk/2",
        ],
        dir,
      );
      expect(scored.status).toBe(plain.status);
    });
  });

  it("names both models in the help, with the default marked", () => {
    withProject({ "page.html": DIRTY }, (dir) => {
      // Whitespace-collapsed: commander wraps the column, so the sentence is there and the line
      // breaks are not the thing under test.
      const help = cli(["scan", "--help"], dir).stdout.replace(/\s+/g, " ");
      expect(help).toContain("fairux-risk/1 | fairux-risk/2");
      expect(help).toContain("default fairux-risk/1");
      expect(help).toContain("comparable only when their versions match");
    });
  });
});
