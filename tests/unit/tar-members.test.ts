import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTarMembers } from "../../scripts/tar-members.mjs";

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
});
