import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const fixablePack = resolve(here, "../../../tests/fixtures/remediation-rule-pack/fixable-pack.mjs");

/**
 * A pre-checked box the *built-in* rules leave alone.
 *
 * "Remember this device" is not a consent label and this page carries no consent context, so
 * `consent/checked-checkbox` stays quiet and the only remediation for the attribute is the fixture
 * pack's. This file is about the pipeline an external pack drives; the two proposing the same edit
 * is its own case, below.
 */
const PAGE = [
  "<main>",
  '  <label><input type="checkbox" checked> Remember this device</label>',
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
    timeout: CLI_SPAWN_TIMEOUT_MS,
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
      expect(result.stderr).toContain("most findings have no mechanical fix");
    }, "<main><p>Nothing here.</p></main>");
  });
});

describe("two rules proposing the same edit", () => {
  /**
   * A built-in rule and a rule pack want the same attribute gone, under different rule ids. Both
   * remediations are valid against the file as scanned, and applying both would delete the same
   * characters twice.
   *
   * This used to fail. The first edit landed, the second was resolved against text the first had
   * already replaced, and was refused as `expected-mismatch` — so a run that produced exactly the
   * requested bytes exited 1 and said the tree was partly fixed. `expected-mismatch` was doing two
   * jobs: protecting a genuinely stale or conflicting edit, which it must go on doing, and
   * reporting a second rule *agreeing* with the first as a failure, which it must not.
   *
   * Identical edits are coalesced now — one physical edit, both remediations accounted for by name.
   * `conflicting-edit-pack.mjs` below is the other half of the claim.
   */
  const CONSENT_PAGE = [
    "<main>",
    "  <h1>Cookie consent</h1>",
    '  <label><input type="checkbox" checked> Email me marketing offers</label>',
    "</main>",
  ].join("\n");

  it("makes the edit once and exits 0", () => {
    withPage((dir, file) => {
      const result = cli(["scan", "page.html", "--fix-write"], dir);

      expect(result.status, result.stderr).toBe(0);
      const after = readFileSync(file, "utf8");
      expect(after).toContain('<input type="checkbox">');
      expect(after).not.toContain("checked");
      // Once, not twice: a second application would have taken eight more characters with it.
      expect(after).toBe(CONSENT_PAGE.replace(" checked", ""));
    }, CONSENT_PAGE);
  });

  it("says which remediation was applied and which was coalesced into it", () => {
    withPage((dir) => {
      const { stderr } = cli(["scan", "page.html", "--fix-write"], dir);

      expect(stderr).toMatch(/applied consent\/checked-checkbox:remove-checked/);
      expect(stderr).toMatch(
        /coalesced fixtures\/pre-checked-box#\d+ .* consent\/checked-checkbox:remove-checked.* makes the identical edit/,
      );
      // Neither word, because neither happened.
      expect(stderr).not.toMatch(/refused fixtures\/pre-checked-box/);
      expect(stderr).not.toContain("partly fixed");
      expect(stderr).toContain("1 applied, 1 coalesced, 0 refused");
    }, CONSENT_PAGE);
  });

  it("reaches the same classification in a dry run, without writing", () => {
    // One plan, whether or not it is written: what a user was shown is what a user gets.
    withPage((dir, file) => {
      const before = readFileSync(file, "utf8");
      const { status, stderr } = cli(["scan", "page.html", "--fix-dry-run"], dir);

      expect(status).toBe(0);
      expect(stderr).toMatch(/would apply consent\/checked-checkbox:remove-checked/);
      expect(stderr).toMatch(/would coalesce fixtures\/pre-checked-box#\d+/);
      expect(stderr).toContain("1 applicable, 1 coalesced, 0 refused");
      expect(readFileSync(file, "utf8")).toBe(before);
    }, CONSENT_PAGE);
  });
});

describe("two rules disagreeing about the same range", () => {
  /**
   * The negative half. `conflicting-edit-pack.mjs` names the same file, the same checksum, the same
   * coordinates, and the same expected text as the built-in remediation — and a different
   * replacement. Everything about it looks like the coalesced case except the one field that says
   * what the file should end up containing.
   *
   * It must stay a refusal and must still fail the run. A rule that wanted something else did not
   * get it, and "the file contains a plausible value now" is not the question.
   */
  const CONSENT_PAGE = [
    "<main>",
    "  <h1>Cookie consent</h1>",
    '  <label><input type="checkbox" checked> Email me marketing offers</label>',
    "</main>",
  ].join("\n");

  const conflictingPack = resolve(
    here,
    "../../../tests/fixtures/remediation-rule-pack/conflicting-edit-pack.mjs",
  );

  function conflicting(args: string[], cwd: string) {
    return spawnSync("node", [cliBin, ...args, "--rule-pack", conflictingPack], {
      encoding: "utf8",
      cwd,
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
  }

  it("exits 1, refuses the disagreeing edit, and coalesces nothing", () => {
    withPage((dir, file) => {
      const result = conflicting(["scan", "page.html", "--fix-write"], dir);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/refused fixtures\/rename-checked#\d+/);
      expect(result.stderr).not.toContain("coalesced");
      // The built-in edit landed; the disagreeing one did not, and left nothing behind.
      const after = readFileSync(file, "utf8");
      expect(after).toContain('<input type="checkbox">');
      expect(after).not.toContain("data-was-checked");
    }, CONSENT_PAGE);
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
    timeout: CLI_SPAWN_TIMEOUT_MS,
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
        timeout: CLI_SPAWN_TIMEOUT_MS,
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
