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
  assertReplaceableSource,
  type FileSystemOps,
  nodeFileSystem,
  replaceArtifact,
  snapshotArtifact,
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
  it("refuses a symlink rather than following it or replacing it", (ctx) => {
    withTempDir((dir) => {
      const real = join(dir, "real.json");
      const link = join(dir, "link.json");
      writeFileSync(real, ORIGINAL, "utf8");
      if (!trySymlink(real, link)) {
        // Reported as a skip rather than passing silently: a case that did not run must not read as
        // one that did.
        ctx.skip("this system does not allow creating symlinks");
        return;
      }

      expect(() => snapshotArtifact(link)).toThrow(UnsafeTargetError);
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
      expect(() => snapshotArtifact(nested)).toThrow(/not a regular file/);
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
      expect(() => snapshotArtifact(fifo)).toThrow(/not a regular file/);
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
});

/**
 * Who owns the file, and whether this process could actually write it.
 *
 * The owner-write bit says *its owner* may write it. That is not the same as saying this process
 * may: a file owned by somebody else, inside a directory this process can write, can be replaced by
 * rename — which succeeds where opening it for writing would have failed, and silently transfers the
 * file to whoever ran the tool.
 *
 * Driven through injected `lstat` and `currentUid` rather than by actually switching users, so it is
 * one deterministic test rather than a suite that only runs as root.
 */
describe("a source owned by somebody else", () => {
  /** The real filesystem, reporting a different owner for `path` and a chosen current uid. */
  function asUser(currentUid: number, owner: { uid: number; gid: number }, path: string) {
    return failing({
      currentUid: () => currentUid,
      lstat: (target) => {
        const stat = nodeFileSystem.lstat(target);
        if (target !== path) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat) as object), stat, owner);
      },
    });
  }

  it("is refused even though its owner-write bit is set", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, ORIGINAL, "utf8");
      const ops = asUser(1000, { uid: 0, gid: 0 }, file);

      expect(() => assertReplaceableSource(file, ops)).toThrow(/owned by another user/);
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    });
  });

  it("is accepted for root, which may rewrite a file it does not own", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, ORIGINAL, "utf8");
      const real = nodeFileSystem.lstat(file);
      const ops = asUser(0, { uid: real.uid, gid: real.gid }, file);
      expect(() => assertReplaceableSource(file, ops)).not.toThrow();
    });
  });

  it("refuses rather than replacing a file with one this process owns, when chown fails", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, ORIGINAL, "utf8");
      const real = nodeFileSystem.lstat(file);
      const ops = failing({
        currentUid: () => 0,
        lstat: (target) => {
          const stat = nodeFileSystem.lstat(target);
          if (target !== file) return stat;
          return Object.assign(Object.create(Object.getPrototypeOf(stat) as object), stat, {
            uid: real.uid + 1,
          });
        },
        fchown: () => {
          throw new Error("EPERM: operation not permitted");
        },
      });

      // Better to write nothing than to write a file whose owner is now somebody it was not.
      expect(() => replaceArtifact(file, "REPLACED\n", ops)).toThrow(/could not give/);
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
      expect(readdirSync(dir)).toEqual(["page.html"]);
    });
  });

  it("does not consult ownership where the platform has no uid", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, ORIGINAL, "utf8");
      // Windows. Ownership is an ACL question this deliberately does not model, and the read-only
      // check above still applies because Node maps that attribute onto the mode.
      const ops = failing({ currentUid: () => undefined });
      expect(() => assertReplaceableSource(file, ops)).not.toThrow();
    });
  });

  it("treats a path that does not exist as a new artifact, and as no source at all", () => {
    withTempDir((dir) => {
      const missing = join(dir, "new.json");
      expect(snapshotArtifact(missing)).toEqual({ state: "absent" });
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
      let interrupted = false;
      const ops = failing({
        rename: (from, to) => {
          throw new Error(`should not have renamed ${from} to ${to}`);
        },
        // Really recreated, not a doctored `Stats` — that does not survive being copied on every
        // platform. With different contents, because a filesystem is free to hand the same inode
        // straight back, and a file that is byte-for-byte what it was is not a file that changed.
        close: (fd) => {
          nodeFileSystem.close(fd);
          if (interrupted) return;
          interrupted = true;
          rmSync(target);
          writeFileSync(target, `${ORIGINAL}${ORIGINAL}`, "utf8");
        },
      });
      expect(() => replaceArtifact(target, CONTENTS, ops)).toThrow(/changed before it could/);
      expect(readFileSync(target, "utf8")).toBe(`${ORIGINAL}${ORIGINAL}`);
    });
  });
});
