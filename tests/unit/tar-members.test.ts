import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTarArchive, readTarMembers } from "../../scripts/tar-members.mjs";

/**
 * `tar -tzf` prints names only, so a symlink, hardlink, or device node lists exactly like the file
 * it replaces. These read the ustar headers directly, which is also why the result is identical on
 * a GNU tar and a bsdtar host.
 */

function header({
  name = "package/index.js",
  size = 0,
  typeflag = "0",
  linkname = "",
  prefix = "",
  mode = 0o644,
}: Partial<{
  name: string;
  size: number;
  typeflag: string;
  linkname: string;
  prefix: string;
  mode: number;
}> = {}) {
  const block = Buffer.alloc(512);
  block.write(name, 0);
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("        ", 148);
  block.write(typeflag, 156);
  block.write(linkname, 157);
  block.write("ustar\x0000", 257);
  block.write(prefix, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

const archive = (...blocks: Buffer[]) => gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));

describe("tar member headers", () => {
  it("reads a regular file", () => {
    expect(readTarMembers(archive(header()))).toEqual([
      {
        name: "package/index.js",
        type: "file",
        typeflag: "0",
        linkname: "",
        size: 0,
        mode: 0o644,
        prefix: "",
      },
    ]);
  });

  it.each([
    ["1", "hardlink"],
    ["2", "symlink"],
    ["3", "character-device"],
    ["4", "block-device"],
    ["5", "directory"],
    ["6", "fifo"],
    ["x", "pax-extended-header"],
    ["L", "gnu-long-name"],
  ])("names typeflag %s as %s", (typeflag, type) => {
    expect(readTarMembers(archive(header({ typeflag })))[0]?.type).toBe(type);
  });

  it("reports an unknown typeflag rather than guessing", () => {
    expect(readTarMembers(archive(header({ typeflag: "Z" })))[0]?.type).toBe("unknown");
  });

  it("reports a symlink's target", () => {
    const [member] = readTarMembers(archive(header({ typeflag: "2", linkname: "/etc/passwd" })));
    expect(member).toMatchObject({ type: "symlink", linkname: "/etc/passwd" });
  });

  it("joins the ustar prefix so a long path is not truncated", () => {
    expect(
      readTarMembers(archive(header({ prefix: "package/dist", name: "index.js" })))[0]?.name,
    ).toBe("package/dist/index.js");
  });

  it("skips a member's content blocks to find the next header", () => {
    const body = Buffer.alloc(512);
    body.write("x".repeat(600 % 512));
    const members = readTarMembers(
      archive(
        header({ name: "package/a.js", size: 600 }),
        Buffer.alloc(1024),
        header({ name: "package/b.js" }),
      ),
    );
    expect(members.map((member) => member.name)).toEqual(["package/a.js", "package/b.js"]);
  });

  it("stops at the end-of-archive marker", () => {
    expect(readTarMembers(archive())).toEqual([]);
  });

  it("preserves a traversal path verbatim rather than normalizing it", () => {
    // The point of reading headers ourselves: `tar` may normalize this away before we see it.
    expect(readTarMembers(archive(header({ name: "package/../../evil" })))[0]?.name).toBe(
      "package/../../evil",
    );
  });

  it("preserves a dot-segment alias, which a listing would collapse", () => {
    expect(readTarMembers(archive(header({ name: "package/dist/./dom.js" })))[0]?.name).toBe(
      "package/dist/./dom.js",
    );
  });

  it("reports both copies of a duplicated path", () => {
    const members = readTarMembers(
      archive(header({ name: "package/dist/dom.js" }), header({ name: "package/dist/dom.js" })),
    );
    expect(members).toHaveLength(2);
  });
});

describe("tar parsing is fail-closed", () => {
  /** A header whose stored checksum is deliberately left wrong. */
  function badChecksum() {
    const block = header();
    block.write("000000\0 ", 148);
    return block;
  }

  it("refuses a header whose checksum does not verify", () => {
    expect(() => readTarMembers(archive(badChecksum()))).toThrow(/checksum does not verify/);
  });

  it("refuses a non-octal numeric field rather than reading it as zero", () => {
    // A silent `0` here would skip a member's body and shift every following header, producing a
    // member list that disagrees with what an extractor sees.
    const block = header({ size: 512 });
    block.write("garbage\0    ", 124);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    expect(() => readTarMembers(archive(block, Buffer.alloc(512)))).toThrow(/valid octal/);
  });

  it("refuses the GNU base-256 numeric encoding rather than decoding it", () => {
    const block = header();
    block[124] = 0x80;
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    expect(() => readTarMembers(archive(block))).toThrow(/base-256/);
  });

  it("refuses a member whose size runs past the end of the archive", () => {
    const block = header({ size: 4096 });
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    expect(() => readTarMembers(gzipSync(Buffer.concat([block, Buffer.alloc(512)])))).toThrow(
      /past the end of the archive/,
    );
  });

  it("refuses a truncated header block", () => {
    expect(() => readTarMembers(gzipSync(Buffer.concat([header(), Buffer.alloc(100, 1)])))).toThrow(
      /truncated header/,
    );
  });

  it("accepts a real pnpm-packed archive shape", () => {
    expect(readTarMembers(archive(header({ name: "package/package.json" })))).toHaveLength(1);
  });
});

/**
 * Reading member *bodies* replaced `tar -xzOf`, which the audits used to pull the manifest, the
 * README, and each dist chunk out of the tarball. That reader decompressed the archive a second
 * time — independently of the header audit that had just run over it — and, handed a path carried
 * by more than one member, printed all of them concatenated while extraction kept only the last.
 * It also does not exist in that form on a Windows runner, which is what made the packed-CLI audit
 * unrunnable on half the platforms the CLI supports.
 */
describe("tar member bodies", () => {
  /** A header plus its body, padded to the 512-byte block the format requires. */
  function file(name: string, contents: string | Buffer) {
    const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    return [header({ name, size: body.length }), padded];
  }

  it("returns exactly the declared size, without the block padding", () => {
    // The padding is NUL bytes: a reader that returned the whole block would hand `JSON.parse` a
    // manifest with a trailing NUL, and hand a byte-count check a number rounded up to 512.
    const { readBody } = readTarArchive(archive(...file("package/package.json", '{"a":1}')));
    const body = readBody("package/package.json");
    expect(body).toHaveLength(7);
    expect(body.toString("utf8")).toBe('{"a":1}');
  });

  it("reads UTF-8 text back unchanged", () => {
    const text = "// ライセンス — © 2026\n";
    const { readBody } = readTarArchive(archive(...file("package/NOTICE", text)));
    expect(readBody("package/NOTICE").toString("utf8")).toBe(text);
  });

  it("returns a fresh buffer each time, so a caller cannot poison a later read", () => {
    const { readBody } = readTarArchive(archive(...file("package/dist/index.js", "export {};")));
    const first = readBody("package/dist/index.js");
    first.fill(0);
    expect(readBody("package/dist/index.js").toString("utf8")).toBe("export {};");
  });

  it("reads the same member repeatedly without drift", () => {
    const { readBody } = readTarArchive(archive(...file("package/README.md", "# fairux\n")));
    expect(readBody("package/README.md")).toEqual(readBody("package/README.md"));
  });

  it("reads each member's own body when several are present", () => {
    const { readBody } = readTarArchive(
      archive(...file("package/a.js", "AAA"), ...file("package/b.js", "BBBB")),
    );
    expect(readBody("package/a.js").toString("utf8")).toBe("AAA");
    expect(readBody("package/b.js").toString("utf8")).toBe("BBBB");
  });

  it("refuses a name carried by more than one member instead of concatenating them", () => {
    // This is the case `tar -xzOf` answered wrongly: the auditor saw `//import "node:fs";` while
    // extraction wrote the second member alone.
    const { readBody } = readTarArchive(
      archive(...file("package/dist/dom.js", "//"), ...file("package/dist/dom.js", 'import "fs";')),
    );
    expect(() => readBody("package/dist/dom.js")).toThrow(/carries 2 members/);
  });

  it("refuses a name no member carries rather than returning empty content", () => {
    const { readBody } = readTarArchive(archive(...file("package/package.json", "{}")));
    expect(() => readBody("package/dist/index.js")).toThrow(/no member named/);
  });

  it("refuses to read the body of a member that is not a regular file", () => {
    const { readBody } = readTarArchive(
      archive(header({ name: "package/dist/dom.js", typeflag: "2", linkname: "/etc/passwd" })),
    );
    expect(() => readBody("package/dist/dom.js")).toThrow(/not a regular file/);
  });

  it("does not resolve a dot-segment alias to the member it shadows", () => {
    // `package/dist/./dom.js` and `package/dist/dom.js` are distinct members here, exactly as the
    // member audit reports them. Silently equating them is what let the alias through.
    const { readBody } = readTarArchive(
      archive(...file("package/dist/dom.js", "real"), ...file("package/dist/./dom.js", "alias")),
    );
    expect(readBody("package/dist/dom.js").toString("utf8")).toBe("real");
    expect(readBody("package/dist/./dom.js").toString("utf8")).toBe("alias");
  });

  it("reports the same members as the header-only reader", () => {
    const bytes = archive(...file("package/package.json", "{}"), ...file("package/README.md", "#"));
    expect(readTarArchive(bytes).members).toEqual(readTarMembers(bytes));
  });

  it("is fail-closed on a malformed archive, like the header-only reader", () => {
    const block = header({ size: 4096 });
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    expect(() => readTarArchive(gzipSync(Buffer.concat([block, Buffer.alloc(512)])))).toThrow(
      /past the end of the archive/,
    );
  });
});
