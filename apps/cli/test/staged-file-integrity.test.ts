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
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type FileSystemOps,
  nodeFileSystem,
  replaceArtifact,
  stageReplacement,
} from "../src/file-replace.js";

/**
 * The staged file, held to the same standard as the target.
 *
 * Checking that the target is still what it was says nothing about the bytes about to be renamed
 * over it. A staged file lives in the same directory under a name anything can find, and between
 * staging and its own rename it can be edited, replaced, or turned into a link — after which the
 * rename publishes somebody else's bytes under the target's name and the run reports success.
 *
 * And a staged file this process did not create is not this process's to remove. `open(..., "wx")`
 * failing with EEXIST means exactly that: the name is taken by a file belonging to somebody else.
 */

const ORIGINAL = '{"original":true}\n';
const NEW = '{"new":true}\n';

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-staged-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stagedIn(dir: string): string | undefined {
  return readdirSync(dir).find((name) => name.endsWith(".fairux-tmp"));
}

describe("a staged name that is already taken", () => {
  it("does not delete the file that is there", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      // A leftover from a crashed run, another process's staging file, or a name somebody claimed
      // deliberately. `wx` refuses to open it — and refusing to open a file is not permission to
      // remove it.
      const taken = join(dir, ".out.json.deadbeef.fairux-tmp");
      writeFileSync(taken, "SOMEBODY ELSE'S BYTES\n", "utf8");

      const ops: FileSystemOps = { ...nodeFileSystem, randomSuffix: () => "deadbeef" };

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      expect(readFileSync(taken, "utf8")).toBe("SOMEBODY ELSE'S BYTES\n");
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });

  it("does not remove anything when the open fails for another reason", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");
      const taken = join(dir, ".out.json.deadbeef.fairux-tmp");
      writeFileSync(taken, "NOT OURS\n", "utf8");

      const ops: FileSystemOps = {
        ...nodeFileSystem,
        randomSuffix: () => "deadbeef",
        open: () => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        },
      };

      expect(() => replaceArtifact(target, NEW, ops)).toThrow(/EACCES/);
      expect(readFileSync(taken, "utf8")).toBe("NOT OURS\n");
    });
  });
});

describe("a staged file that changed before its rename", () => {
  /**
   * Stage a file, tamper with it, then try to commit.
   *
   * Fired after the staged file has been read to record what it is, which is the window this is
   * about: staging is finished, the rename has not happened, and nothing has looked at the staged
   * file since. No sleeps and no second process.
   */
  function stageThenTamper(dir: string, tamper: (temporary: string) => void) {
    const target = join(dir, "out.json");
    writeFileSync(target, ORIGINAL, "utf8");
    let tampered = false;
    const ops: FileSystemOps = {
      ...nodeFileSystem,
      readBytes: (path) => {
        const bytes = nodeFileSystem.readBytes(path);
        if (!tampered && path.endsWith(".fairux-tmp")) {
          tampered = true;
          tamper(path);
        }
        return bytes;
      },
    };
    return { target, ops };
  }

  it("refuses when its contents were edited", () => {
    withTempDir((dir) => {
      const { target, ops } = stageThenTamper(dir, (temporary) => {
        writeFileSync(temporary, "TAMPERED\n", "utf8");
      });

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      // Neither the tampered bytes nor the intended ones: the target is what it was.
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });

  it("refuses when it was replaced by a different file", () => {
    withTempDir((dir) => {
      const { target, ops } = stageThenTamper(dir, (temporary) => {
        rmSync(temporary);
        writeFileSync(temporary, NEW, "utf8");
      });

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });

  it("refuses when it was replaced by a symlink", () => {
    withTempDir((dir) => {
      const elsewhere = join(dir, "elsewhere.json");
      writeFileSync(elsewhere, "SOMEWHERE ELSE\n", "utf8");
      const { target, ops } = stageThenTamper(dir, (temporary) => {
        rmSync(temporary);
        symlinkSync(elsewhere, temporary);
      });

      let threw = false;
      try {
        replaceArtifact(target, NEW, ops);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
      expect(readFileSync(elsewhere, "utf8")).toBe("SOMEWHERE ELSE\n");
    });
  });

  it.skipIf(process.platform === "win32")("refuses when its mode was changed", () => {
    withTempDir((dir) => {
      const { target, ops } = stageThenTamper(dir, (temporary) => {
        chmodSync(temporary, 0o666);
      });

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });

  it.skipIf(process.platform === "win32")("refuses when it gained a hard link", () => {
    withTempDir((dir) => {
      const { target, ops } = stageThenTamper(dir, (temporary) => {
        linkSync(temporary, join(dir, "another-name"));
      });

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
    });
  });
});

describe("cleaning up a staged file that is no longer ours", () => {
  it("does not remove a different file that took the staged path", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");

      let swapped = false;
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        // Fail the rename so cleanup runs, and swap the staged path for somebody else's file first.
        rename: () => {
          const staged = stagedIn(dir);
          if (staged && !swapped) {
            swapped = true;
            rmSync(join(dir, staged));
            writeFileSync(join(dir, staged), "NOT THE STAGED FILE\n", "utf8");
          }
          throw new Error("EPERM: operation not permitted");
        },
      };

      expect(() => replaceArtifact(target, NEW, ops)).toThrow();
      const leftover = stagedIn(dir);
      expect(leftover).toBeDefined();
      // Cleanup that deletes by name alone removes whatever now holds that name.
      expect(readFileSync(join(dir, leftover as string), "utf8")).toBe("NOT THE STAGED FILE\n");
    });
  });
});

describe("bytes, not decoded text", () => {
  it("notices a change between two invalid UTF-8 sequences", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.bin");
      // Both decode to the same replacement character, so hashing the decoded string cannot tell
      // them apart — and the file's identity is its bytes.
      writeFileSync(target, Buffer.from([0x80]));
      let tampered = false;
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        close: (fd) => {
          nodeFileSystem.close(fd);
          if (tampered) return;
          tampered = true;
          writeFileSync(target, Buffer.from([0x81]));
        },
      };

      expect(() => replaceArtifact(target, NEW, ops)).toThrow(/changed before it could/);
      expect(readFileSync(target)).toEqual(Buffer.from([0x81]));
    });
  });

  it("notices a same-size binary change", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.bin");
      writeFileSync(target, Buffer.from([0x00, 0x01, 0x02, 0x03]));
      let tampered = false;
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        close: (fd) => {
          nodeFileSystem.close(fd);
          if (tampered) return;
          tampered = true;
          writeFileSync(target, Buffer.from([0x00, 0x01, 0x02, 0x04]));
        },
      };

      expect(() => replaceArtifact(target, NEW, ops)).toThrow(/changed before it could/);
    });
  });

  it("notices a NUL byte appearing", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.bin");
      writeFileSync(target, Buffer.from("abcd", "utf8"));
      let tampered = false;
      const ops: FileSystemOps = {
        ...nodeFileSystem,
        close: (fd) => {
          nodeFileSystem.close(fd);
          if (tampered) return;
          tampered = true;
          writeFileSync(target, Buffer.from([0x61, 0x62, 0x00, 0x64]));
        },
      };

      expect(() => replaceArtifact(target, NEW, ops)).toThrow(/changed before it could/);
    });
  });
});

describe("staging into a directory that cannot hold the file", () => {
  it("reports the failure without touching anything", () => {
    withTempDir((dir) => {
      const nested = join(dir, "sub");
      mkdirSync(nested);
      const target = join(nested, "out.json");
      writeFileSync(target, ORIGINAL, "utf8");

      const ops: FileSystemOps = {
        ...nodeFileSystem,
        open: () => {
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
      };

      expect(() => stageReplacement(target, NEW, { ops })).toThrow(/ENOSPC/);
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
      expect(readdirSync(nested)).toEqual(["out.json"]);
      expect(statSync(target).size).toBe(ORIGINAL.length);
    });
  });
});
