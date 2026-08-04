import {
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeFixPlan, planFixes, writeFixes } from "../src/fix.js";
import { composeCliRulePacks } from "../src/load-rule-pack.js";
import { scanFileReport } from "../src/scan-file.js";
import {
  nodeSourceIo,
  rewriteSourceInPlace,
  SourceChangedError,
  SourcePathChangedError,
  SourceRestoreFailedError,
  sha256,
} from "../src/source-write.js";

/**
 * Every byte outside the edit, and the file itself when a write goes wrong.
 *
 * A fix means one range of bytes changes. Getting there involves decoding the file to a string,
 * applying an edit, and encoding it back — each of which has a way of quietly rewriting something
 * else. A decoder replaces invalid sequences with U+FFFD, and strips a BOM. And if the write fails
 * partway, whatever is put back has to be the file that was there, not a version of it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixablePack = resolve(here, "../../../tests/fixtures/remediation-rule-pack/fixable-pack.mjs");

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CHECKED = '<label><input type="checkbox" checked> ';
const UNCHECKED = '<label><input type="checkbox"> ';

async function packs() {
  const composed = await composeCliRulePacks([fixablePack], { includeExperimental: false });
  return composed.packs;
}

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-bytes-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fix a file made of these exact bytes, and hand back what is on disk afterwards. */
async function fixBytes(source: Buffer): Promise<{ after: Buffer; described: string }> {
  const rulePacks = await packs();
  return withTempDir((dir) => {
    const file = join(dir, "page.html");
    writeFileSync(file, source);
    const plan = planFixes(
      scanFileReport(file, { format: "json", toolVersion: "test", rulePacks }),
    );
    const outcome = writeFixes(plan);
    return { after: readFileSync(file), described: describeFixPlan(plan, outcome) };
  });
}

describe("bytes a fix leaves alone", () => {
  it("keeps a UTF-8 BOM", async () => {
    const source = Buffer.concat([BOM, Buffer.from(`<main>\n  ${CHECKED}x</label>\n</main>\n`)]);
    const { after } = await fixBytes(source);
    // Decoding strips it and encoding does not put it back, so a fix that round-trips through a
    // string silently deletes three bytes at the start of the file.
    expect(after.subarray(0, 3)).toEqual(BOM);
    expect(after.toString("utf8")).toContain(UNCHECKED);
  });

  it("keeps CRLF line endings", async () => {
    const source = Buffer.from(`<main>\r\n  ${CHECKED}x</label>\r\n</main>\r\n`, "utf8");
    const { after } = await fixBytes(source);
    expect(after.toString("utf8").split("\r\n")).toHaveLength(4);
    expect(after.includes(Buffer.from("\n\n"))).toBe(false);
  });

  it("keeps multibyte characters and a NUL byte", async () => {
    const source = Buffer.concat([
      Buffer.from(`<main>\n  ${CHECKED}メールを受け取る`, "utf8"),
      Buffer.from([0x00]),
      Buffer.from("</label>\n</main>\n", "utf8"),
    ]);
    const { after } = await fixBytes(source);
    expect(after.includes(Buffer.from("メールを受け取る", "utf8"))).toBe(true);
    expect(after.includes(0x00)).toBe(true);
  });

  it("changes nothing but the edit", async () => {
    const source = Buffer.from(
      `<main>\r\n  ${CHECKED}メール</label>\r\n  <p>  spaced  </p>\r\n</main>\r\n`,
      "utf8",
    );
    const { after } = await fixBytes(source);
    // The whole file, byte for byte, with one substring replaced.
    expect(after).toEqual(Buffer.from(source.toString("utf8").replace(CHECKED, UNCHECKED), "utf8"));
  });

  it("does not rewrite a file that is not valid UTF-8", async () => {
    const source = Buffer.concat([
      Buffer.from(`<main>\n  ${CHECKED}`, "utf8"),
      // A lone 0x80: no valid UTF-8 sequence starts with it. Decoding turns it into U+FFFD, and
      // writing that back would change three bytes nowhere near the finding.
      Buffer.from([0x80]),
      Buffer.from("</label>\n</main>\n", "utf8"),
    ]);
    const { after, described } = await fixBytes(source);
    expect(after).toEqual(source);
    expect(described).toContain("does not survive a UTF-8 round trip");
    // And the dry run says the same thing, rather than promising a fix it would then refuse.
    expect(described).not.toMatch(/would apply/);
  });
});

describe("rewriteSourceInPlace", () => {
  const ORIGINAL = "original contents, which are longer than what replaces them\n";
  const NEW = "new\n";

  function withFile<T>(body: (file: string, dir: string) => T, contents = ORIGINAL): T {
    return withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, contents, "utf8");
      return body(file, dir);
    });
  }

  const checksumOf = (contents: string) => sha256(Buffer.from(contents, "utf8"));

  it("writes through when the checksum matches", () => {
    withFile((file, dir) => {
      rewriteSourceInPlace(file, NEW, checksumOf(ORIGINAL));
      expect(readFileSync(file, "utf8")).toBe(NEW);
      // In place, so nothing was created beside it, and the file shrank rather than keeping a tail
      // of the old contents.
      expect(readdirSync(dir)).toEqual(["page.html"]);
    });
  });

  it("refuses when the checksum does not match", () => {
    withFile((file) => {
      expect(() => rewriteSourceInPlace(file, NEW, checksumOf("something else"))).toThrow(
        SourceChangedError,
      );
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    });
  });

  it("fails without creating a file it cannot open", () => {
    withTempDir((dir) => {
      expect(() => rewriteSourceInPlace(join(dir, "gone.html"), NEW, "whatever")).toThrow();
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("puts the original back, byte for byte, when the write fails partway", () => {
    withFile((file) => {
      const newBytes = Buffer.from(NEW, "utf8");
      let calls = 0;
      expect(() =>
        rewriteSourceInPlace(file, NEW, checksumOf(ORIGINAL), {
          ...nodeSourceIo,
          write: (fd, bytes, offset, length, position) => {
            // Only the new contents fail. The restore that follows is a real write, which is the
            // point: what it puts back has to be the original file and nothing else.
            if (!bytes.subarray(0, newBytes.length).equals(newBytes)) {
              return nodeSourceIo.write(fd, bytes, offset, length, position);
            }
            calls += 1;
            // The first call writes one byte for real, so the file has been truncated and the
            // descriptor has moved. Then it fails.
            if (calls === 1) return nodeSourceIo.write(fd, bytes, offset, 1, position);
            throw new Error("EIO: injected write failure");
          },
        }),
      ).toThrow(/EIO/);

      const after = readFileSync(file);
      // Byte for byte. A restore that wrote from the descriptor's current position would leave the
      // original preceded by NUL bytes — a corrupt file, reported to the user as a failed write.
      expect(after).toEqual(Buffer.from(ORIGINAL, "utf8"));
      expect(after.includes(0x00)).toBe(false);
    });
  });

  it("puts the original back when fsync fails after a complete write", () => {
    withFile((file) => {
      let syncs = 0;
      expect(() =>
        rewriteSourceInPlace(file, NEW, checksumOf(ORIGINAL), {
          ...nodeSourceIo,
          fsync: (fd) => {
            syncs += 1;
            if (syncs === 1) throw new Error("EIO: injected fsync failure");
            nodeSourceIo.fsync(fd);
          },
        }),
      ).toThrow(/EIO/);

      expect(readFileSync(file)).toEqual(Buffer.from(ORIGINAL, "utf8"));
    });
  });

  it("says so when the restore fails too, rather than reporting a plain write failure", () => {
    withFile((file) => {
      let calls = 0;
      expect(() =>
        rewriteSourceInPlace(file, NEW, checksumOf(ORIGINAL), {
          ...nodeSourceIo,
          write: (fd, bytes, offset, _length, position) => {
            calls += 1;
            if (calls === 1) return nodeSourceIo.write(fd, bytes, offset, 1, position);
            // Every subsequent write fails, including the restore. This is the file really being
            // damaged, and the point is that the run says so.
            throw new Error("ENOSPC: no space left on device");
          },
        }),
      ).toThrow(SourceRestoreFailedError);
      // The file really is damaged here. What matters is that the run says so instead of reporting
      // a write that failed and leaving the user to assume nothing happened.
    });
  });

  /**
   * POSIX only, because the race itself is.
   *
   * Windows refuses to rename over a file that is open, so an editor cannot replace the path while
   * this holds a descriptor on it. The check still runs there — it just has nothing to catch, and a
   * test that tried to stage one would be testing `rename`'s error rather than this.
   */
  it.skipIf(process.platform === "win32")(
    "refuses when the path is replaced after it was opened",
    () => {
      withFile((file, dir) => {
        const replacement = "SOMEBODY ELSE'S ATOMIC SAVE\n";
        expect(() =>
          rewriteSourceInPlace(file, NEW, checksumOf(ORIGINAL), {
            ...nodeSourceIo,
            read: (fd) => {
              const bytes = nodeSourceIo.read(fd);
              // An editor saving atomically, after this file was opened and read. The descriptor is
              // still valid and still refers to the old inode — which the path no longer names.
              const staging = join(dir, ".editor-tmp");
              writeFileSync(staging, replacement, "utf8");
              renameSync(staging, file);
              return bytes;
            },
          }),
        ).toThrow(SourcePathChangedError);

        // Nothing at the path was touched, and nothing was written to the file that used to be there.
        expect(readFileSync(file, "utf8")).toBe(replacement);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not write the fix into a hard link when the path is replaced",
    () => {
      withFile((file, dir) => {
        const other = join(dir, "other-name.html");
        linkSync(file, other);
        const replacement = "SOMEBODY ELSE'S ATOMIC SAVE\n";
        let writes = 0;

        expect(() =>
          rewriteSourceInPlace(file, NEW, checksumOf(ORIGINAL), {
            ...nodeSourceIo,
            read: (fd) => {
              const bytes = nodeSourceIo.read(fd);
              const staging = join(dir, ".editor-tmp");
              writeFileSync(staging, replacement, "utf8");
              renameSync(staging, file);
              return bytes;
            },
            write: (fd, bytes, offset, length, position) => {
              writes += 1;
              return nodeSourceIo.write(fd, bytes, offset, length, position);
            },
          }),
        ).toThrow(SourcePathChangedError);

        // Caught before the truncate, so nothing was written and nothing had to be undone. A check
        // that only ran after the write would leave the fix visible in the other name until the
        // restore put it back.
        expect(writes).toBe(0);

        // The file that was scanned is unfixed, and the fix must not have gone to the other name
        // instead — which is where writing through the stale descriptor would have put it.
        expect(readFileSync(file, "utf8")).toBe(replacement);
        expect(readFileSync(other, "utf8")).toBe(ORIGINAL);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "puts the original back into the file it was writing when the path is replaced",
    () => {
      withFile((file, dir) => {
        // A second name for the same inode, so the file the descriptor refers to stays observable
        // after the path stops naming it.
        const other = join(dir, "other-name.html");
        linkSync(file, other);
        const replacement = "SOMEBODY ELSE'S ATOMIC SAVE\n";
        let swapped = false;

        expect(() =>
          rewriteSourceInPlace(file, NEW, checksumOf(ORIGINAL), {
            ...nodeSourceIo,
            write: (fd, bytes, offset, length, position) => {
              const written = nodeSourceIo.write(fd, bytes, offset, length, position);
              if (!swapped) {
                swapped = true;
                const staging = join(dir, ".editor-tmp");
                writeFileSync(staging, replacement, "utf8");
                renameSync(staging, file);
              }
              return written;
            },
          }),
        ).toThrow(SourcePathChangedError);

        expect(readFileSync(file, "utf8")).toBe(replacement);
        // The file that was being written is back to what it was. Reporting the replacement without
        // undoing the write would leave the fix in a file the user never asked to change.
        expect(readFileSync(other, "utf8")).toBe(ORIGINAL);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves the path alone when it is replaced during the write",
    () => {
      withFile((file, dir) => {
        const replacement = "SOMEBODY ELSE'S ATOMIC SAVE\n";
        let swapped = false;
        expect(() =>
          rewriteSourceInPlace(file, NEW, checksumOf(ORIGINAL), {
            ...nodeSourceIo,
            write: (fd, bytes, offset, length, position) => {
              const written = nodeSourceIo.write(fd, bytes, offset, length, position);
              if (!swapped) {
                swapped = true;
                const staging = join(dir, ".editor-tmp");
                writeFileSync(staging, replacement, "utf8");
                renameSync(staging, file);
              }
              return written;
            },
          }),
        ).toThrow(SourcePathChangedError);

        expect(readFileSync(file, "utf8")).toBe(replacement);
      });
    },
  );
});
