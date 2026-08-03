import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FileSystemOps, nodeFileSystem, replaceArtifact } from "../src/file-replace.js";

/**
 * Every way the target can differ between the first look and the rename.
 *
 * Checking that "the file that was there is still the file that is there" covers one row of this
 * table and leaves the rest open. A target that did not exist and now does, a target that existed
 * and now does not, and a target edited in place without changing inode or size are all states where
 * renaming over it destroys something — and all three were allowed.
 *
 * The interruption is injected at `close`, which is the moment staging finishes and the commit-time
 * check has not yet run. No sleeps, no second process, and the same behaviour on every platform.
 */

const ORIGINAL = '{"original":true}\n';
const OTHER = '{"someone":"else"}\n';
const NEW = '{"new":true}\n';

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-transitions-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `interrupt` once, the moment the staged file is closed and before anything is renamed. */
function interruptingAfterStage(interrupt: () => void): FileSystemOps {
  let fired = false;
  return {
    ...nodeFileSystem,
    close: (fd) => {
      nodeFileSystem.close(fd);
      if (!fired) {
        fired = true;
        interrupt();
      }
    },
  };
}

/** Nothing beside the target: a staged file left behind means the rename never happened. */
function expectNoLeftovers(dir: string, ...expected: string[]) {
  expect(readdirSync(dir).sort()).toEqual([...expected].sort());
}

describe("the target's state between staging and the rename", () => {
  it("absent → absent: creates the file", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      replaceArtifact(target, NEW);
      expect(readFileSync(target, "utf8")).toBe(NEW);
      expectNoLeftovers(dir, "out.json");
    });
  });

  it("absent → present: refuses, and keeps what the other writer put there", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      const ops = interruptingAfterStage(() => writeFileSync(target, OTHER, "utf8"));

      expect(() => replaceArtifact(target, NEW, ops)).toThrow(/created|changed/i);
      // Nothing about "the output did not exist when we started" makes it ours to overwrite now.
      expect(readFileSync(target, "utf8")).toBe(OTHER);
      expectNoLeftovers(dir, "out.json");
    });
  });

  it("present → absent: refuses rather than resurrecting a deleted file", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops = interruptingAfterStage(() => rmSync(target));

      expect(() => replaceArtifact(target, NEW, ops)).toThrow(/deleted|changed/i);
      // A deletion is a decision. Putting the file back is not this tool's call.
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("present → present, same inode, different size: refuses", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops = interruptingAfterStage(() =>
        writeFileSync(target, `${OTHER}${OTHER}${OTHER}`, "utf8"),
      );

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      expect(readFileSync(target, "utf8")).toBe(`${OTHER}${OTHER}${OTHER}`);
    });
  });

  it("present → present, same inode, same size, different bytes: refuses", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      // Byte-for-byte the same length, written in place. Nothing about the inode or the size says
      // anything changed; only the contents do.
      const sameLength = `${"x".repeat(ORIGINAL.length - 1)}\n`;
      expect(sameLength.length).toBe(ORIGINAL.length);
      const ops = interruptingAfterStage(() => writeFileSync(target, sameLength, "utf8"));

      expect(() => replaceArtifact(target, NEW, ops)).toThrow(/contents changed|changed/i);
      expect(readFileSync(target, "utf8")).toBe(sameLength);
    });
  });

  it("present → symlink: refuses", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      const elsewhere = join(dir, "elsewhere.json");
      writeFileSync(target, ORIGINAL, "utf8");
      writeFileSync(elsewhere, OTHER, "utf8");
      const ops = interruptingAfterStage(() => {
        rmSync(target);
        symlinkSync(elsewhere, target);
      });

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      expect(readFileSync(elsewhere, "utf8")).toBe(OTHER);
    });
  });

  it.skipIf(process.platform === "win32")("present → hard-linked: refuses", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops = interruptingAfterStage(() => linkSync(target, join(dir, "other-name.json")));

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });

  it("present → directory: refuses", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops = interruptingAfterStage(() => {
        rmSync(target);
        mkdirSync(target);
      });

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      expect(readdirSync(target)).toEqual([]);
    });
  });
});

describe("a target whose state cannot be determined", () => {
  const codes = ["EACCES", "EIO", "ENOTDIR", "ELOOP"] as const;

  for (const code of codes) {
    it(`refuses rather than treating ${code} as "the file is not there"`, () => {
      withTempDir((dir) => {
        const target = join(dir, "out.json");
        writeFileSync(target, ORIGINAL, "utf8");
        const ops: FileSystemOps = {
          ...nodeFileSystem,
          lstat: (path) => {
            if (path === target) {
              throw Object.assign(new Error(`${code}: injected`), { code });
            }
            return nodeFileSystem.lstat(path);
          },
        };

        // "I could not find out what this is" is not "there is nothing here".
        expect(() => replaceArtifact(target, NEW, ops)).toThrow(new RegExp(code));
        expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
        expectNoLeftovers(dir, "out.json");
      });
    });
  }

  it("still treats ENOENT as absent", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      replaceArtifact(target, NEW);
      expect(readFileSync(target, "utf8")).toBe(NEW);
    });
  });
});

describe("what is left behind when a write fails", () => {
  it("names the leftover file when cleanup also fails", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        rename: () => {
          throw new Error("EPERM: operation not permitted");
        },
        unlink: () => {
          throw new Error("EACCES: cleanup refused");
        },
      };

      let thrown: Error | undefined;
      try {
        replaceArtifact(target, NEW, ops);
      } catch (error) {
        thrown = error as Error;
      }

      // The staged file holds the new contents and is still on disk. Saying nothing about it leaves
      // a user with a file they did not create and no idea where it came from.
      expect(thrown?.message).toMatch(/EPERM/);
      expect(thrown?.message).toMatch(/fairux-tmp/);
      expect(thrown?.message).toMatch(/could not be removed|left behind/i);
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });
});

describe("what a staged file is visible as before it is complete", () => {
  /**
   * The ordering contract, which holds on every platform.
   *
   * Another process sharing the directory can list and open the staged file by name. A file created
   * at the target's final mode would be readable by them while it was still empty or half-written,
   * so the private mode has to come first and the target's mode only after the contents are there.
   */
  it("is opened private, and given the target's mode only after the write", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");

      const calls: string[] = [];
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        open: (path, flags, mode) => {
          calls.push(`open:${(mode ?? 0).toString(8)}`);
          return nodeFileSystem.open(path, flags, mode);
        },
        write: (fd, buffer, offset, length) => {
          calls.push("write");
          return nodeFileSystem.write(fd, buffer, offset, length);
        },
        fchmod: (fd, mode) => {
          calls.push(`fchmod:${(mode & 0o777).toString(8)}`);
          nodeFileSystem.fchmod(fd, mode);
        },
      };

      replaceArtifact(target, NEW, ops);

      expect(calls[0]).toBe("open:600");
      expect(calls.indexOf("write")).toBeLessThan(calls.findIndex((c) => c.startsWith("fchmod")));
    });
  });

  it.skipIf(process.platform === "win32")(
    "is not group- or world-readable while incomplete",
    () => {
      withTempDir((dir) => {
        const target = join(dir, "out.json");
        writeFileSync(target, ORIGINAL, "utf8");
        chmodSync(target, 0o644);

        const modesWhenWritten: number[] = [];
        const ops: FileSystemOps = {
          ...nodeFileSystem,
          write: (fd, buffer, offset, length) => {
            const staged = readdirSync(dir).find((name) => name.endsWith(".fairux-tmp"));
            if (staged) modesWhenWritten.push(nodeFileSystem.lstat(join(dir, staged)).mode & 0o777);
            return nodeFileSystem.write(fd, buffer, offset, length);
          },
        };

        replaceArtifact(target, NEW, ops);

        expect(modesWhenWritten.length).toBeGreaterThan(0);
        for (const mode of modesWhenWritten) {
          expect(mode & 0o077).toBe(0);
        }
        expect(nodeFileSystem.lstat(target).mode & 0o777).toBe(0o644);
      });
    },
  );
});
