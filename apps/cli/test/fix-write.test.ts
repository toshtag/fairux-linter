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
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

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
const staleChecksumPack = resolve(
  here,
  "../../../tests/fixtures/remediation-rule-pack/stale-checksum-pack.mjs",
);

/** POSIX mode bits and link counts do not carry the same meaning on Windows. */
const posix = process.platform !== "win32";

// "Remember this device" is not a consent label, so `consent/checked-checkbox` stays quiet and the
// fixture pack's remediation is the only one for this attribute — which is what these tests drive.
const PAGE =
  '<main>\n  <label><input type="checkbox" checked> Remember this device</label>\n</main>\n';
const FIXED = '<main>\n  <label><input type="checkbox"> Remember this device</label>\n</main>\n';
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
    timeout: CLI_SPAWN_TIMEOUT_MS,
  });
}

describe("a plan written against the file it was planned from", () => {
  it("leaves nothing beside the file it rewrote", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      writeFixes(plan(file, rulePacks));
      expect(readdirSync(dir)).toEqual(["page.html"]);
    });
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
  it("writes through a symlink to the file it points at", async (ctx) => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const real = join(dir, "real.html");
      const link = join(dir, "link.html");
      writeFileSync(real, PAGE, "utf8");
      try {
        symlinkSync(real, link);
      } catch {
        // A skip, not a silent pass: a case that did not run must not be counted as one that did.
        ctx.skip("this system does not allow creating symlinks");
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
  it("exits 1 when a safe remediation could not be applied", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      // A pack whose remediation was computed against different bytes — what a real pack produces
      // when the file changes between the scan and the fix. The applier refuses it, and a refused
      // safe fix is a fix somebody asked for and did not get.
      const result = spawnSync(
        "node",
        [
          cliBin,
          "scan",
          "page.html",
          "--ignore-config",
          "--rule-pack",
          staleChecksumPack,
          "--fix-write",
        ],
        { encoding: "utf8", cwd: dir, timeout: CLI_SPAWN_TIMEOUT_MS },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("the file changed since the scan");
      expect(result.stderr).toContain("0 applied");
      expect(readFileSync(file, "utf8")).toBe(PAGE);
    });
  });

  it.skipIf(!posix)("exits 1 when the file cannot be written at all", () => {
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
});
