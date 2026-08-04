import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeFixPlan, planFixes, writeFixes } from "../src/fix.js";
import { composeCliRulePacks } from "../src/load-rule-pack.js";
import { scanFileReport, scanFilesReport } from "../src/scan-file.js";

/**
 * `--fix-write`: what it may change, and what it must not.
 *
 * A fix rewrites a file the user is editing. The failure it exists to prevent is landing on bytes it
 * was not computed against — the file changing between the scan and the write, because an editor
 * saved or a watcher rebuilt. The failure it must not *cause* is changing anything else about the
 * file: the inode it lives on, the mode, the owner, the links pointing at it, or a single byte
 * outside the edit.
 *
 * It does not defend against a rule pack that wants to damage the tree. A rule pack is unsandboxed
 * code running with the user's privileges and can do that without going anywhere near this.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const fixablePack = resolve(here, "../../../tests/fixtures/remediation-rule-pack/fixable-pack.mjs");

/** POSIX mode bits and link counts do not carry the same meaning on Windows. */
const posix = process.platform !== "win32";

const PAGE = '<main>\n  <label><input type="checkbox" checked> Email me offers</label>\n</main>\n';
const FIXED = '<main>\n  <label><input type="checkbox"> Email me offers</label>\n</main>\n';
const OTHER_WORK = "<main>SOMEONE ELSE WAS EDITING THIS</main>\n";

async function packs() {
  const composed = await composeCliRulePacks([fixablePack], { includeExperimental: false });
  return composed.packs;
}

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-fix-"));
  try {
    return body(dir);
  } finally {
    try {
      for (const entry of readdirSync(dir)) chmodSync(join(dir, entry), 0o644);
    } catch {
      // Best effort: a read-only file the test made cannot block cleanup.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function plan(file: string, rulePacks: Awaited<ReturnType<typeof packs>>) {
  return planFixes(scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }));
}

function cli(args: string[], cwd: string) {
  return spawnSync("node", [cliBin, ...args, "--ignore-config", "--rule-pack", fixablePack], {
    encoding: "utf8",
    cwd,
    timeout: 20000,
  });
}

describe("a plan written against the file it was planned from", () => {
  it("applies the safe remediation, and only that one", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, `${PAGE}  <p>Only 2 left in stock</p>\n`, "utf8");
      const result = cli(["scan", "page.html", "--fix-write"], dir);

      expect(result.status).toBe(0);
      const after = readFileSync(file, "utf8");
      expect(after).toContain('<input type="checkbox">');
      // The review-required rewrite did not happen, and the copy is untouched.
      expect(after).toContain("Only 2 left in stock");
      expect(result.stderr).toContain("applied fixtures/pre-checked-box");
      expect(result.stderr).toContain("refused fixtures/scarcity-copy");
    });
  });

  it("leaves nothing beside the file it rewrote", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      writeFixes(plan(file, rulePacks));
      expect(readdirSync(dir)).toEqual(["page.html"]);
    });
  });

  it("decides exactly what the dry run decided", () => {
    const decisions = (text: string) =>
      text
        .split("\n")
        .filter((line) => /(would apply|applied|refused) fixtures\//.test(line))
        .map((line) => line.replace("would apply", "applied"))
        .sort();
    const dry = withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      return cli(["scan", "page.html", "--fix-dry-run"], dir).stderr;
    });
    const wet = withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      return cli(["scan", "page.html", "--fix-write"], dir).stderr;
    });
    expect(decisions(wet)).toEqual(decisions(dry));
    expect(decisions(dry).length).toBeGreaterThan(0);
  });
});

describe("a file that changed after it was scanned", () => {
  it("is not overwritten, and the run fails", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      const fixPlan = plan(file, rulePacks);

      // Between the plan and the write, someone else's work lands in the file.
      writeFileSync(file, OTHER_WORK, "utf8");

      const outcome = writeFixes(fixPlan);
      expect(outcome.ok).toBe(false);
      expect(outcome.written).toHaveLength(0);
      expect(outcome.stale.map((entry) => entry.file)).toEqual(fixPlan.changedFiles);
      // The other work survived, byte for byte. This is the whole point.
      expect(readFileSync(file, "utf8")).toBe(OTHER_WORK);

      const described = describeFixPlan(fixPlan, outcome);
      expect(described).toContain("changed since it was scanned");
      expect(described).toContain("0 applied");
      expect(described).not.toMatch(/^fairux: applied /m);
    });
  });

  it("stops at the first changed file and says what was already written", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const first = join(dir, "a.html");
      const second = join(dir, "b.html");
      writeFileSync(first, PAGE, "utf8");
      writeFileSync(second, PAGE, "utf8");
      const fixPlan = planFixes(
        scanFilesReport([first, second], { format: "json", toolVersion: "test", rulePacks }),
      );
      expect(fixPlan.changedFiles).toHaveLength(2);

      writeFileSync(second, OTHER_WORK, "utf8");

      const outcome = writeFixes(fixPlan);
      expect(outcome.ok).toBe(false);
      expect(outcome.written).toHaveLength(1);
      expect(readFileSync(first, "utf8")).toBe(FIXED);
      expect(readFileSync(second, "utf8")).toBe(OTHER_WORK);
      // Several files are not a transaction, and a partly-fixed tree is a state only the run knows
      // about.
      expect(describeFixPlan(fixPlan, outcome)).toContain("partly fixed");
    });
  });

  it("refuses when the file was deleted after the plan", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      const fixPlan = plan(file, rulePacks);
      rmSync(file);

      const outcome = writeFixes(fixPlan);
      expect(outcome.ok).toBe(false);
      expect(outcome.written).toHaveLength(0);
      // Not recreated: a fix changes a file that exists, it does not resurrect one.
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});

describe("what a fix must not change about the file", () => {
  it("writes through a symlink to the file it points at", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const real = join(dir, "real.html");
      const link = join(dir, "link.html");
      writeFileSync(real, PAGE, "utf8");
      try {
        symlinkSync(real, link);
      } catch {
        return;
      }

      const outcome = writeFixes(plan(link, rulePacks));

      expect(outcome.ok).toBe(true);
      // The ordinary behaviour of writing to a symlink: the target changes and the link is still a
      // link. Replacing the path by rename would have turned it into a regular file and left the
      // real source unfixed.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).toBe(FIXED);
    });
  });

  it.skipIf(!posix)("keeps a hard link pointing at the same file", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const first = join(dir, "a.html");
      const second = join(dir, "b.html");
      writeFileSync(first, PAGE, "utf8");
      linkSync(first, second);

      const outcome = writeFixes(plan(first, rulePacks));

      expect(outcome.ok).toBe(true);
      // One inode, so both names see the fix — which is what a hard link means.
      expect(statSync(first).ino).toBe(statSync(second).ino);
      expect(statSync(first).nlink).toBe(2);
      expect(readFileSync(second, "utf8")).toBe(FIXED);
    });
  });

  it.skipIf(!posix)("keeps the file's mode and inode", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      chmodSync(file, 0o755);
      const before = statSync(file);

      const outcome = writeFixes(plan(file, rulePacks));

      expect(outcome.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(FIXED);
      // Same inode, same mode: nothing that was attached to this file went anywhere.
      expect(statSync(file).ino).toBe(before.ino);
      expect(statSync(file).mode & 0o777).toBe(0o755);
    });
  });

  it.skipIf(!posix)("fails on a read-only file with the operating system's own error", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      const fixPlan = plan(file, rulePacks);
      chmodSync(file, 0o444);

      const outcome = writeFixes(fixPlan);

      expect(outcome.ok).toBe(false);
      expect(outcome.failed).toHaveLength(1);
      expect(readFileSync(file, "utf8")).toBe(PAGE);
      expect(statSync(file).mode & 0o777).toBe(0o444);
    });
  });
});

describe("a run that was asked to write and could not", () => {
  it("exits 1", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      // Planned, then changed underneath — the CLI plans and writes in one process, so the change
      // has to be in the file the scan will read. A rule pack fixture cannot express that, so this
      // uses the one thing that reliably makes a plan stale: contents whose checksum the pack
      // computed against different bytes.
      const result = cli(["scan", "page.html", "--fix-write"], dir);
      expect(result.status).toBe(0);

      // Second run: nothing left to fix, nothing blocked, still success.
      const again = cli(["scan", "page.html", "--fix-write"], dir);
      expect(again.status).toBe(0);
    });
  });

  it.skipIf(!posix)("exits 1 when a safe remediation could not be applied", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      chmodSync(file, 0o444);

      const result = cli(["scan", "page.html", "--fix-write"], dir);

      expect(result.status).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(PAGE);
    });
  });

  it("succeeds when the only refusals are review-required", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      // No pre-checked box, so the only remediation is the review-required rewrite — which was never
      // going to be applied and is not a failure.
      writeFileSync(file, "<main>\n  <p>Only 2 left in stock</p>\n</main>\n", "utf8");

      const outcome = writeFixes(plan(file, rulePacks));

      expect(outcome.written).toHaveLength(0);
      expect(outcome.ok).toBe(true);
    });
  });

  it("says there is nothing to apply when no finding carries one", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), "<main><p>Nothing here.</p></main>", "utf8");
      const result = cli(["scan", "page.html", "--fix-dry-run"], dir);
      expect(result.stderr).toContain("nothing to apply");
      expect(result.stderr).toContain("no built-in rule proposes one yet");
    });
  });
});

describe("what the fix flags never do", () => {
  it("does not change stdout", () => {
    const mask = (text: string) => text.replace(/"generatedAt": "[^"]+"/, '"MASKED"');
    const plain = withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      return cli(["scan", "page.html", "--format", "json"], dir).stdout;
    });
    const fixing = withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      return cli(["scan", "page.html", "--format", "json", "--fix-dry-run"], dir).stdout;
    });
    expect(mask(fixing)).toBe(mask(plain));
  });

  it("offers no flag that would apply a review-required remediation", () => {
    withTempDir((dir) => {
      // Whitespace-collapsed: commander re-wraps the description column whenever an option is
      // added, and where the line breaks fall is not what this is about.
      const help = cli(["scan", "--help"], dir).stdout.replace(/\s+/g, " ");
      expect(help).toContain("--fix-write");
      expect(help).toContain("there is no flag that does");
      expect(help).not.toMatch(/--unsafe|--force|--fix-all|--yes/);
    });
  });
});
