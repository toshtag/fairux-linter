import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReplaceableArtifact,
  assertReplaceableSource,
  type FileSystemOps,
  nodeFileSystem,
  replaceArtifact,
  UnsafeTargetError,
} from "../src/file-replace.js";

/**
 * Replacing a file without destroying what it was.
 *
 * The failure paths are driven through an injected filesystem rather than through directory
 * permissions: a read-only directory does not stop a superuser and does not mean the same thing on
 * Windows, so a permission-based test is one that quietly stops running exactly where it is most
 * needed. Every case here runs as any user, on every platform.
 */

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-replace-"));
  try {
    return body(dir);
  } finally {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Already writable, or gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The real filesystem, with one operation replaced. */
function failing(overrides: Partial<FileSystemOps>): FileSystemOps {
  return { ...nodeFileSystem, ...overrides };
}

/**
 * POSIX mode bits and link counts do not mean on Windows what they mean here.
 *
 * Only the assertions *about* them are skipped. Everything that matters on both platforms — short
 * writes, failing renames, cleanup, the checks around a commit — runs everywhere, because it is
 * driven through injected operations rather than through the filesystem's permission model.
 */
const posix = process.platform !== "win32";

/** Symlinks need a privilege on Windows that CI does not necessarily have. */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

const CONTENTS = '{"new":true}\n';
const ORIGINAL = '{"original":true,"padding":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';

describe("what may be replaced", () => {
  it("refuses a symlink rather than following it or replacing it", () => {
    withTempDir((dir) => {
      const real = join(dir, "real.json");
      const link = join(dir, "link.json");
      writeFileSync(real, ORIGINAL, "utf8");
      if (!trySymlink(real, link)) return;

      expect(() => assertReplaceableArtifact(link)).toThrow(UnsafeTargetError);
      expect(() => assertReplaceableSource(link)).toThrow(/symbolic link/);
      // Following it would rewrite a file the user did not name; replacing it would turn the link
      // into a regular file. Neither happened.
      expect(readFileSync(real, "utf8")).toBe(ORIGINAL);
    });
  });

  it.skipIf(!posix)("refuses a hard-linked file rather than breaking the link apart", () => {
    withTempDir((dir) => {
      const first = join(dir, "a.json");
      const second = join(dir, "b.json");
      writeFileSync(first, ORIGINAL, "utf8");
      linkSync(first, second);

      expect(() => assertReplaceableSource(first)).toThrow(/hard links/);
      expect(statSync(first).nlink).toBe(2);
    });
  });

  it("refuses a directory", () => {
    withTempDir((dir) => {
      const nested = join(dir, "sub");
      mkdirSync(nested);
      expect(() => assertReplaceableArtifact(nested)).toThrow(/not a regular file/);
    });
  });

  it.skipIf(!posix)("refuses a FIFO", () => {
    withTempDir((dir) => {
      const fifo = join(dir, "pipe");
      try {
        execFileSync("mkfifo", [fifo]);
      } catch {
        // No `mkfifo` on this system. The directory case above exercises the same check.
        return;
      }
      expect(() => assertReplaceableArtifact(fifo)).toThrow(/not a regular file/);
    });
  });

  it.skipIf(!posix)("refuses a read-only source, whatever the directory allows", () => {
    withTempDir((dir) => {
      const file = join(dir, "read-only.html");
      writeFileSync(file, ORIGINAL, "utf8");
      chmodSync(file, 0o444);
      // The mode bit rather than an access check: `access(W_OK)` is true for root, which would make
      // this pass in CI and fail for the user it protects.
      expect(() => assertReplaceableSource(file)).toThrow(/read-only/);
    });
  });

  it.skipIf(!posix)("accepts an ordinary file, and reports what it is", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, ORIGINAL, "utf8");
      chmodSync(file, 0o755);
      const identity = assertReplaceableSource(file);
      expect(identity.nlink).toBe(1);
      expect(identity.mode & 0o777).toBe(0o755);
    });
  });

  it("treats a path that does not exist as a new artifact, and as no source at all", () => {
    withTempDir((dir) => {
      const missing = join(dir, "new.json");
      expect(assertReplaceableArtifact(missing)).toBeUndefined();
      expect(() => assertReplaceableSource(missing)).toThrow(/does not exist/);
    });
  });
});

describe("replaceArtifact", () => {
  it("creates a file that did not exist", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      replaceArtifact(target, CONTENTS);
      expect(readFileSync(target, "utf8")).toBe(CONTENTS);
      expect(readdirSync(dir)).toEqual(["out.json"]);
    });
  });

  it.skipIf(!posix)("keeps the mode of the file it replaces", () => {
    withTempDir((dir) => {
      const target = join(dir, "baseline.json");
      writeFileSync(target, ORIGINAL, "utf8");
      chmodSync(target, 0o600);
      replaceArtifact(target, CONTENTS);
      // A baseline a user restricted to themselves does not come back world-readable because the
      // tool rewrote it.
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, "utf8")).toBe(CONTENTS);
    });
  });

  it("leaves no temporary file behind", () => {
    withTempDir((dir) => {
      replaceArtifact(join(dir, "out.json"), CONTENTS);
      replaceArtifact(join(dir, "out.json"), CONTENTS);
      expect(readdirSync(dir)).toEqual(["out.json"]);
    });
  });
});

describe("a write that fails partway", () => {
  /** Assert the target is untouched and nothing was left beside it. */
  function expectUntouched(dir: string, target: string) {
    expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    // `basename`, not a split on "/": the separator is "\\" on Windows, and a hand-rolled split
    // silently compares a full path against a filename and fails for the wrong reason.
    expect(readdirSync(dir)).toEqual([basename(target)]);
  }

  it("completes when the filesystem writes in several short pieces", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const chunks: number[] = [];
      // Short writes are legal and ordinary; treating one call as the whole write is what makes a
      // truncated file get renamed into place.
      const ops = failing({
        write: (fd, buffer, offset, length) => {
          const written = nodeFileSystem.write(fd, buffer, offset, Math.min(4, length));
          chunks.push(written);
          return written;
        },
      });
      replaceArtifact(target, CONTENTS, ops);
      expect(chunks.length).toBeGreaterThan(1);
      expect(readFileSync(target, "utf8")).toBe(CONTENTS);
    });
  });

  it("refuses to rename a partial write when progress stops", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      let calls = 0;
      const ops = failing({
        write: (fd, buffer, offset, length) => {
          calls += 1;
          if (calls === 1) return nodeFileSystem.write(fd, buffer, offset, Math.min(3, length));
          // Zero forever: the disk is full, the quota is hit, something is wrong.
          return 0;
        },
      });
      expect(() => replaceArtifact(target, CONTENTS, ops)).toThrow(/stopped making progress/);
      expectUntouched(dir, target);
    });
  });

  it("leaves the original intact when the write throws", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops = failing({
        write: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      });
      expect(() => replaceArtifact(target, CONTENTS, ops)).toThrow(/ENOSPC/);
      expectUntouched(dir, target);
    });
  });

  it("leaves the original intact when fsync fails", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops = failing({
        fsync: () => {
          throw new Error("EIO: i/o error");
        },
      });
      expect(() => replaceArtifact(target, CONTENTS, ops)).toThrow(/EIO/);
      expectUntouched(dir, target);
    });
  });

  it("leaves the original intact when close fails", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      let closed = false;
      const ops = failing({
        close: (fd) => {
          // Closed for real first, so the descriptor does not leak into the rest of the run.
          if (!closed) {
            closed = true;
            nodeFileSystem.close(fd);
            throw new Error("EIO: close failed");
          }
        },
      });
      expect(() => replaceArtifact(target, CONTENTS, ops)).toThrow(/close failed/);
      expectUntouched(dir, target);
    });
  });

  it("leaves the original intact when the rename fails", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops = failing({
        rename: () => {
          throw new Error("EPERM: operation not permitted");
        },
      });
      expect(() => replaceArtifact(target, CONTENTS, ops)).toThrow(/EPERM/);
      // The staged file is cleaned up too, so a failed run does not litter the directory it could
      // not write to.
      expectUntouched(dir, target);
    });
  });

  it("reports the real failure even when cleanup also fails", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops = failing({
        rename: () => {
          throw new Error("EXDEV: cross-device link");
        },
        unlink: () => {
          throw new Error("EACCES: cleanup also failed");
        },
      });
      // The cleanup failure is the less useful of the two, and it must not replace the one that
      // says what actually went wrong.
      expect(() => replaceArtifact(target, CONTENTS, ops)).toThrow(/EXDEV/);
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });

  it("refuses when the target was replaced between staging and the rename", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      let looks = 0;
      const ops = failing({
        rename: (from, to) => {
          throw new Error(`should not have renamed ${from} to ${to}`);
        },
        // The first look is the real file. The second — the check immediately before the rename —
        // sees a different inode, because something recreated the path in between.
        lstat: (path) => {
          const stat = nodeFileSystem.lstat(path);
          if (path !== target) return stat;
          looks += 1;
          if (looks === 1) return stat;
          return Object.assign(Object.create(Object.getPrototypeOf(stat) as object), stat, {
            ino: stat.ino + 1,
          });
        },
      });
      expect(() => replaceArtifact(target, CONTENTS, ops)).toThrow(/different file/);
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });
});
