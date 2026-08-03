import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/atomic-write.js";

/**
 * A failed write must not destroy what was there.
 *
 * `writeFileSync` truncates before it writes, so an interrupted write leaves an empty file where a
 * valid one used to be — for a baseline or a Risk Index, a file that parses as nothing rather than
 * as either version.
 */

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-atomic-"));
  try {
    return body(dir);
  } finally {
    // Restore write permission first: a test that made the directory read-only cannot be cleaned up
    // otherwise, and the failure would be attributed to whatever ran next.
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Already writable, or gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read-only directories do not stop a superuser, so the failure paths cannot be tested as one. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("writeFileAtomic", () => {
  it("creates a file that did not exist", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileAtomic(target, '{"a":1}\n');
      expect(readFileSync(target, "utf8")).toBe('{"a":1}\n');
      expect(readdirSync(dir)).toEqual(["out.json"]);
    });
  });

  it("replaces an existing file", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, "old contents that are longer than the new ones\n", "utf8");
      writeFileAtomic(target, "new\n");
      expect(readFileSync(target, "utf8")).toBe("new\n");
    });
  });

  it("leaves no temporary file behind on success", () => {
    withTempDir((dir) => {
      writeFileAtomic(join(dir, "out.json"), "{}\n");
      writeFileAtomic(join(dir, "out.json"), "{}\n");
      expect(readdirSync(dir)).toEqual(["out.json"]);
    });
  });

  it("writes into the target's own directory, so the rename is not a cross-device copy", () => {
    withTempDir((dir) => {
      const nested = join(dir, "reports");
      mkdirSync(nested);
      const target = join(nested, "index.json");
      writeFileAtomic(target, "{}\n");
      expect(statSync(target).isFile()).toBe(true);
    });
  });

  it.skipIf(isRoot)("leaves the original intact when the write fails", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      const original = '{"kept":true}\n';
      writeFileSync(target, original, "utf8");
      // No new file can be created here, so the temp file cannot be opened — the failure happens
      // before anything touches the target.
      chmodSync(dir, 0o555);

      expect(() => writeFileAtomic(target, '{"lost":true}\n')).toThrow();
      expect(readFileSync(target, "utf8")).toBe(original);
    });
  });

  it.skipIf(isRoot)("leaves no temporary file behind when the write fails", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, "{}\n", "utf8");
      chmodSync(dir, 0o555);
      try {
        writeFileAtomic(target, "new\n");
      } catch {
        // The throw is asserted above; this test is about what is left on disk.
      }
      chmodSync(dir, 0o755);
      expect(readdirSync(dir)).toEqual(["out.json"]);
    });
  });

  it("does not truncate the target before the new contents are complete", () => {
    withTempDir((dir) => {
      const target = join(dir, "out.json");
      writeFileSync(target, "x".repeat(4096), "utf8");
      // The target's inode is replaced rather than rewritten, so a reader holding the old one keeps
      // reading the old contents rather than watching them shrink to nothing.
      const before = statSync(target).ino;
      writeFileAtomic(target, "y\n");
      expect(statSync(target).ino).not.toBe(before);
      expect(readFileSync(target, "utf8")).toBe("y\n");
    });
  });
});
