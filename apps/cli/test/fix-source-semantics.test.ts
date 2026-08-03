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
import { type FileSystemOps, nodeFileSystem } from "../src/file-replace.js";
import { describeFixPlan, planFixes, writeFixes } from "../src/fix.js";
import { composeCliRulePacks } from "../src/load-rule-pack.js";
import { scanFileReport, scanFilesReport } from "../src/scan-file.js";

/**
 * What a fix must not change about the file it fixes.
 *
 * Replacing a file by rename is safe for a file this tool owns and wrong for a file a user is
 * editing: it turns a symlink into a regular file, gives a hard-linked file a new inode, and resets
 * the mode. Worse, it can report `applied` for a symlink whose target is still exactly as it was —
 * a fix that did not happen, described as one that did.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixablePack = resolve(here, "../../../tests/fixtures/remediation-rule-pack/fixable-pack.mjs");

/** POSIX mode bits and link counts do not carry the same meaning on Windows. */
const posix = process.platform !== "win32";

const PAGE = '<main>\n  <label><input type="checkbox" checked> Email me offers</label>\n</main>\n';
const OTHER_WORK = "<main>SOMEONE ELSE WAS EDITING THIS</main>\n";

async function packs() {
  const composed = await composeCliRulePacks([fixablePack], { includeExperimental: false });
  return composed.packs;
}

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-fix-semantics-"));
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

describe("a source file a fix must not silently change", () => {
  it("refuses a symlink, and never claims to have fixed one", async (ctx) => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const real = join(dir, "real.html");
      const link = join(dir, "link.html");
      writeFileSync(real, PAGE, "utf8");
      try {
        symlinkSync(real, link);
      } catch {
        // Reported as a skip rather than passing silently: symlinks need a privilege Windows CI
        // does not necessarily have, and a case that did not run must not read as one that did.
        ctx.skip("this system does not allow creating symlinks");
        return;
      }

      const plan = planFixes(
        scanFileReport(link, { format: "json", toolVersion: "test", rulePacks }),
      );
      const outcome = writeFixes(plan);

      // `lstat`, not `stat`: `stat` follows the link and reports the file at the other end, so it
      // says nothing at all about whether the link itself survived.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(["link.html", "real.html"]);
      expect(readFileSync(real, "utf8")).toBe(PAGE);
      expect(outcome.written).toHaveLength(0);

      // And the report says so, in the dry run as well as the write. Reporting `applied` here would
      // describe a fix to a source file that is exactly as it was.
      const described = describeFixPlan(plan, outcome);
      expect(described).toContain("symbolic link");
      expect(described).not.toMatch(/^fairux: applied /m);
      expect(describeFixPlan(plan)).not.toMatch(/would apply/);
    });
  });

  it.skipIf(!posix)("refuses a hard-linked file rather than breaking the link", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const first = join(dir, "a.html");
      const second = join(dir, "b.html");
      writeFileSync(first, PAGE, "utf8");
      linkSync(first, second);

      const plan = planFixes(
        scanFileReport(first, { format: "json", toolVersion: "test", rulePacks }),
      );
      const outcome = writeFixes(plan);

      expect(outcome.written).toHaveLength(0);
      // Both names still point at one inode, and both still have the original contents.
      expect(statSync(first).nlink).toBe(2);
      expect(statSync(first).ino).toBe(statSync(second).ino);
      expect(readFileSync(first, "utf8")).toBe(PAGE);
      expect(describeFixPlan(plan, outcome)).toContain("hard links");
    });
  });

  it.skipIf(!posix)("keeps an executable file executable", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      chmodSync(file, 0o755);

      const plan = planFixes(
        scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
      );
      const outcome = writeFixes(plan);

      expect(outcome.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toContain('<input type="checkbox">');
      // A fix that silently dropped the execute bit would break whatever ran the file.
      expect(statSync(file).mode & 0o777).toBe(0o755);
    });
  });

  it.skipIf(!posix)("refuses a read-only file, whatever the directory permits", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      chmodSync(file, 0o444);

      const plan = planFixes(
        scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
      );
      const outcome = writeFixes(plan);

      expect(outcome.written).toHaveLength(0);
      expect(readFileSync(file, "utf8")).toBe(PAGE);
      expect(statSync(file).mode & 0o777).toBe(0o444);
      expect(describeFixPlan(plan, outcome)).toContain("read-only");
    });
  });
});

describe("a source owned by somebody else", () => {
  it("is not fixed, and nothing is written through the directory", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      // A file owned by another user, in a directory this process can write. A rename would have
      // succeeded and taken the file; opening it for writing would not have.
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        currentUid: () => 1000,
        lstat: (target) => {
          const stat = nodeFileSystem.lstat(target);
          if (!target.endsWith("page.html")) return stat;
          return Object.assign(Object.create(Object.getPrototypeOf(stat) as object), stat, {
            uid: 0,
            gid: 0,
          });
        },
      };

      const plan = planFixes(
        scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
        ops,
      );
      const outcome = writeFixes(plan, ops);

      expect(outcome.written).toHaveLength(0);
      expect(readFileSync(file, "utf8")).toBe(PAGE);
      expect(readdirSync(dir)).toEqual(["page.html"]);
      expect(describeFixPlan(plan, outcome)).toContain("owned by another user");
    });
  });
});

describe("a file that changes during the commit", () => {
  it("does not overwrite a later file that was edited after its own preflight", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const first = join(dir, "a.html");
      const second = join(dir, "b.html");
      writeFileSync(first, PAGE, "utf8");
      writeFileSync(second, PAGE, "utf8");

      const plan = planFixes(
        scanFilesReport([first, second], { format: "json", toolVersion: "test", rulePacks }),
      );
      expect(plan.changedFiles).toHaveLength(2);

      // The edit lands between the two renames, not before the run: preflight has already passed for
      // both files. No sleep, no race — the hook fires exactly when the first commit completes.
      let renames = 0;
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        rename: (from, to) => {
          nodeFileSystem.rename(from, to);
          renames += 1;
          if (renames === 1) writeFileSync(second, OTHER_WORK, "utf8");
        },
      };

      const outcome = writeFixes(plan, ops);

      expect(renames).toBe(1);
      expect(outcome.ok).toBe(false);
      expect(outcome.written).toHaveLength(1);
      expect(readFileSync(first, "utf8")).toContain('<input type="checkbox">');
      // The work that landed mid-commit survived.
      expect(readFileSync(second, "utf8")).toBe(OTHER_WORK);
      expect(outcome.stale.map((entry) => entry.file)).toHaveLength(1);

      const described = describeFixPlan(plan, outcome);
      expect(described).toContain("is not what the plan described");
      // The partial state is stated rather than left for the user to discover.
      expect(described).toContain("partly fixed");
    });
  });

  it("leaves no staged file behind when a commit is abandoned", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const first = join(dir, "a.html");
      const second = join(dir, "b.html");
      writeFileSync(first, PAGE, "utf8");
      writeFileSync(second, PAGE, "utf8");
      const plan = planFixes(
        scanFilesReport([first, second], { format: "json", toolVersion: "test", rulePacks }),
      );

      let renames = 0;
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        rename: (from, to) => {
          nodeFileSystem.rename(from, to);
          renames += 1;
          if (renames === 1) writeFileSync(second, OTHER_WORK, "utf8");
        },
      };
      writeFixes(plan, ops);

      expect(readdirSync(dir).sort()).toEqual(["a.html", "b.html"]);
    });
  });

  it("stages nothing into place when staging itself fails", async () => {
    const rulePacks = await packs();
    withTempDir((dir) => {
      const first = join(dir, "a.html");
      const second = join(dir, "b.html");
      writeFileSync(first, PAGE, "utf8");
      writeFileSync(second, PAGE, "utf8");
      const plan = planFixes(
        scanFilesReport([first, second], { format: "json", toolVersion: "test", rulePacks }),
      );

      let opens = 0;
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        open: (path, flags) => {
          opens += 1;
          if (opens === 2) throw new Error("ENOSPC: no space left on device");
          return nodeFileSystem.open(path, flags);
        },
      };
      const outcome = writeFixes(plan, ops);

      expect(outcome.ok).toBe(false);
      expect(outcome.written).toHaveLength(0);
      // Staging touches no target, so a failure there costs nothing at all.
      expect(readFileSync(first, "utf8")).toBe(PAGE);
      expect(readFileSync(second, "utf8")).toBe(PAGE);
      expect(readdirSync(dir).sort()).toEqual(["a.html", "b.html"]);
    });
  });
});
