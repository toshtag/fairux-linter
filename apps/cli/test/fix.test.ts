import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      // Whitespace-collapsed: commander re-wraps the description column whenever an option is
      // added, and where the line breaks fall is not what this is about.
      const help = cli(["scan", "--help"], dir).stdout.replace(/\s+/g, " ");
      expect(help).toContain("--fix-write");
      expect(help).toContain("there is no flag that does");
      expect(help).not.toMatch(/--unsafe|--force|--fix-all|--yes/);
    });
  });
});

const modelOnlyPack = resolve(
  here,
  "../../../tests/fixtures/remediation-rule-pack/model-only-pack.mjs",
);

function modelOnlyCli(args: string[], cwd: string) {
  return spawnSync("node", [cliBin, ...args, "--rule-pack", modelOnlyPack], {
    encoding: "utf8",
    cwd,
    timeout: 20000,
  });
}

/**
 * The other half of the same feature: a pack that opens the file can find an attribute, and until
 * `source-range` existed that was the only way. A built-in rule cannot do it — `@fairux/core` and
 * `@fairux/rules` are browser-safe — so the schema was usable by external packs and unusable by the
 * rules this project ships.
 */
describe("a fix built from the model, with no filesystem in reach", () => {
  it("reports `source-range` as available on an HTML scan", () => {
    withPage((dir) => {
      const report = JSON.parse(
        modelOnlyCli(["scan", "page.html", "--format", "json"], dir).stdout,
      );
      expect(report.coverage.capabilities.available).toContain("source-range");
      expect(report.coverage.capabilities.unavailable).not.toContain("source-range");
    });
  });

  it("applies an edit the rule never read a byte to build", () => {
    withPage((dir, file) => {
      const result = modelOnlyCli(["scan", "page.html", "--fix-write"], dir);
      expect(result.stderr).toContain("applied fixtures/model-only-checked");
      expect(readFileSync(file, "utf8")).toContain('<input type="checkbox">');
    });
  });

  it("lands on exactly the bytes the pack that reads the file lands on", () => {
    // Two rules, two ways of finding the same attribute, one result. A disagreement here would mean
    // the ranges are off by something the applier happened to tolerate.
    const fromModel = withPage((dir, file) => {
      modelOnlyCli(["scan", "page.html", "--fix-write"], dir);
      return readFileSync(file, "utf8");
    });
    const fromFile = withPage((dir, file) => {
      cli(["scan", "page.html", "--fix-write"], dir);
      return readFileSync(file, "utf8");
    });
    expect(fromModel).toBe(fromFile);
  });
});

/**
 * `stdin.html` is a label, not a path.
 *
 * A scan of stdin has no file to fix. The report names the source `stdin.html` so a reader has
 * something to look at, and a remediation carries that name through — at which point the fix planner
 * reads it as a path. A file called `stdin.html` in the working directory is then read, planned
 * against, and rewritten: a file nobody scanned, edited on the strength of bytes that came from
 * somewhere else entirely.
 */
describe("stdin and the fix flags", () => {
  const PIPED = [
    "<main>",
    '  <label><input type="checkbox" checked> Email me offers</label>',
    "</main>",
    "",
  ].join("\n");

  function withDecoyFile<T>(body: (dir: string, decoy: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "fairux-stdin-"));
    try {
      const decoy = join(dir, "stdin.html");
      writeFileSync(decoy, PIPED, "utf8");
      return body(dir, decoy);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function pipedScan(args: string[], cwd: string, pack = modelOnlyPack) {
    return spawnSync(
      "node",
      [cliBin, "scan", "-", "--ignore-config", "--rule-pack", pack, ...args],
      {
        encoding: "utf8",
        cwd,
        input: PIPED,
        timeout: 20000,
      },
    );
  }

  it("refuses --fix-write rather than rewriting a same-named local file", () => {
    withDecoyFile((dir, decoy) => {
      const before = readFileSync(decoy);
      const result = pipedScan(["--fix-write"], dir);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("filesystem input");
      expect(result.stderr).not.toContain("applied");
      // The file that happened to share the label's name is untouched.
      expect(readFileSync(decoy)).toEqual(before);
    });
  });

  it("refuses --fix-dry-run, rather than planning against whatever that name resolves to", () => {
    withDecoyFile((dir) => {
      const result = pipedScan(["--fix-dry-run"], dir);
      expect(result.status).toBe(2);
      expect(result.stderr).not.toMatch(/would apply/);
      expect(result.stderr).not.toMatch(/ENOENT/);
    });
  });

  it("refuses before loading the rule pack", () => {
    withDecoyFile((dir) => {
      const marker = join(dir, "MARKER");
      const pack = join(dir, "marker-pack.mjs");
      writeFileSync(
        pack,
        [
          'import { writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          'writeFileSync(join(import.meta.dirname, "MARKER"), "ran\\n", "utf8");',
          "export const markerPack = {",
          '  meta: { id: "@fixtures/marker", version: "0.0.0-test.0", engineApiVersion: "1",',
          '    title: "Marker", status: "stable" },',
          "  rules: [],",
          "};",
          "export default markerPack;",
        ].join("\n"),
        "utf8",
      );

      const result = pipedScan(["--fix-write"], dir, pack);

      expect(result.status).toBe(2);
      // An invocation that was never valid must not reach trusted, unsandboxed code.
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).not.toContain("as trusted code");
    });
  });

  it("still scans stdin when no fix flag is present", () => {
    withDecoyFile((dir, decoy) => {
      const before = readFileSync(decoy);
      const result = pipedScan(["--format", "json"], dir);

      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.input.file).toBe("stdin.html");
      expect(report.findings.length).toBeGreaterThan(0);
      expect(readFileSync(decoy)).toEqual(before);
    });
  });
});
