import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeFixPlan, planFixes, writeFixes } from "../src/fix.js";
import { composeCliRulePacks } from "../src/load-rule-pack.js";
import { scanFileReport } from "../src/scan-file.js";
import { rewriteSourceInPlace, SourceChangedError, sha256 } from "../src/source-write.js";

/**
 * Every byte outside the edit.
 *
 * A fix means one range of bytes changes. Getting there involves decoding the file to a string,
 * applying an edit, and encoding it back — and each of those steps has a way of quietly rewriting
 * something else. A decoder replaces invalid sequences with U+FFFD. A decoder strips a BOM. An
 * encoder normalises. None of it is near the finding, and none of it is what a user asked for.
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
});

describe("bytes a fix refuses to touch", () => {
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
  const ORIGINAL = "original contents\n";

  it("refuses when the checksum does not match", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, ORIGINAL, "utf8");
      expect(() =>
        rewriteSourceInPlace(file, "new\n", sha256(Buffer.from("something else"))),
      ).toThrow(SourceChangedError);
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    });
  });

  it("writes through when it does", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, ORIGINAL, "utf8");
      rewriteSourceInPlace(file, "new\n", sha256(Buffer.from(ORIGINAL, "utf8")));
      expect(readFileSync(file, "utf8")).toBe("new\n");
      // In place, so nothing was created beside it.
      expect(readdirSync(dir)).toEqual(["page.html"]);
    });
  });

  it("shrinks a file rather than leaving the tail of the old contents", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      const long = `${"x".repeat(4096)}\n`;
      writeFileSync(file, long, "utf8");
      rewriteSourceInPlace(file, "short\n", sha256(Buffer.from(long, "utf8")));
      expect(readFileSync(file, "utf8")).toBe("short\n");
    });
  });

  it("fails without touching a file it cannot open", () => {
    withTempDir((dir) => {
      const missing = join(dir, "gone.html");
      expect(() => rewriteSourceInPlace(missing, "new\n", "whatever")).toThrow();
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});
