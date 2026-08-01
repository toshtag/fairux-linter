import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const fixablePack = resolve(here, "../../../tests/fixtures/remediation-rule-pack/fixable-pack.mjs");

const PAGE = [
  "<main>",
  '  <label><input type="checkbox" checked> Email me offers</label>',
  "  <p>Only 2 left in stock</p>",
  "</main>",
].join("\n");

function withPage<T>(run: (dir: string, file: string) => T, contents = PAGE): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-fix-"));
  try {
    const file = join(dir, "page.html");
    writeFileSync(file, contents, "utf8");
    return run(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args: string[], cwd: string) {
  return spawnSync("node", [cliBin, ...args, "--rule-pack", fixablePack], {
    encoding: "utf8",
    cwd,
    timeout: 20000,
  });
}

describe("--fix-dry-run", () => {
  it("says what would apply and changes nothing", () => {
    withPage((dir, file) => {
      const before = readFileSync(file, "utf8");
      const result = cli(["scan", "page.html", "--fix-dry-run"], dir);
      expect(result.stderr).toContain("would apply fixtures/pre-checked-box");
      expect(result.stderr).toContain("nothing was written");
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  });

  it("reports every refusal, not only what it can do", () => {
    withPage((dir) => {
      const result = cli(["scan", "page.html", "--fix-dry-run"], dir);
      // A skipped fix nobody was told about is the same silence as one that landed on wrong bytes.
      expect(result.stderr).toContain("refused fixtures/scarcity-copy");
      expect(result.stderr).toContain("needs review");
    });
  });
});

describe("--fix-write", () => {
  it("applies the safe remediation, and only that one", () => {
    withPage((dir, file) => {
      const result = cli(["scan", "page.html", "--fix-write"], dir);
      const after = readFileSync(file, "utf8");
      expect(after).toContain('<input type="checkbox">');
      // The review-required rewrite did not happen, and the copy is untouched.
      expect(after).toContain("Only 2 left in stock");
      expect(result.stderr).toContain("applied fixtures/pre-checked-box");
      expect(result.stderr).toContain("refused fixtures/scarcity-copy");
    });
  });

  it("decides exactly what the dry run decided", () => {
    // Two paths that agree in tests and diverge in practice is how this feature goes wrong. They
    // share one plan; this compares the decisions rather than the wording, which is the part that
    // must not differ.
    const decisions = (text: string) =>
      text
        .split("\n")
        .filter((line) => /(would apply|applied|refused) fixtures\//.test(line))
        .map((line) => line.replace("would apply", "applied"))
        .sort();
    const dry = withPage((dir) => cli(["scan", "page.html", "--fix-dry-run"], dir).stderr);
    const wet = withPage((dir) => cli(["scan", "page.html", "--fix-write"], dir).stderr);
    expect(decisions(wet)).toEqual(decisions(dry));
    expect(decisions(dry).length).toBeGreaterThan(0);
  });

  it("writes nothing when every remediation is refused", () => {
    withPage((dir, file) => {
      const before = readFileSync(file, "utf8");
      const result = cli(["scan", "page.html", "--fix-write"], dir);
      expect(result.stderr).toContain("refused fixtures/scarcity-copy");
      expect(result.stderr).toContain("0 applied");
      // Untouched, down to the byte. The refusal paths themselves — a changed file, a mismatched
      // expectation, overlapping edits — are unit-tested in `applyRemediations`, which is the same
      // code this runs.
      expect(readFileSync(file, "utf8")).toBe(before);
    }, "<main>\n  <p>Only 2 left in stock</p>\n</main>");
  });

  it("says there is nothing to apply when no finding carries one", () => {
    withPage((dir) => {
      const result = cli(["scan", "page.html", "--fix-dry-run"], dir);
      expect(result.stderr).toContain("nothing to apply");
      expect(result.stderr).toContain("no built-in rule proposes one yet");
    }, "<main><p>Nothing here.</p></main>");
  });
});

describe("what the fix flags never do", () => {
  it("does not change stdout", () => {
    withPage((dir) => {
      const plain = cli(["scan", "page.html", "--format", "json"], dir).stdout;
      const fixing = cli(["scan", "page.html", "--format", "json", "--fix-dry-run"], dir).stdout;
      const mask = (text: string) => text.replace(/"generatedAt": "[^"]+"/, '"MASKED"');
      expect(mask(fixing)).toBe(mask(plain));
    });
  });

  it("does not change the exit code", () => {
    // A fresh copy per invocation: writing changes the findings, so reusing one directory would
    // compare two different pages rather than two flag sets.
    const withFix = withPage((dir) =>
      cli(["scan", "page.html", "--fail-on", "medium", "--fix-write"], dir),
    );
    const without = withPage((dir) => cli(["scan", "page.html", "--fail-on", "medium"], dir));
    // Whether a fix was available says nothing about whether the finding should fail the build.
    expect(withFix.status).toBe(without.status);
    expect(withFix.status).toBe(1);
    expect(withPage((dir) => cli(["scan", "page.html", "--fix-write"], dir).status)).toBe(0);
  });

  it("offers no flag that would apply a review-required remediation", () => {
    withPage((dir) => {
      const help = cli(["scan", "--help"], dir);
      expect(help.stdout).toContain("--fix-write");
      expect(help.stdout).toContain("there is no flag that does");
      expect(help.stdout).not.toMatch(/--unsafe|--force|--fix-all|--yes/);
    });
  });
});
