/**
 * Read a gzipped tar's member headers without extracting it.
 *
 * The packed-tarball audits used `tar -tzf`, which prints names and nothing else. A name is not
 * enough to know what a member *is*: `dist/dom.js` may be a symlink to `/etc/passwd`, a hardlink,
 * or a device node, and every one of those lists as `dist/dom.js`. Names also arrive already
 * normalized by the tar implementation, so `package/dist/./dom.js` — a distinct member that
 * overwrites `package/dist/dom.js` on extraction — is invisible from the listing.
 *
 * Reading the 512-byte headers ourselves gives the typeflag, link target, and path verbatim,
 * identically on GNU tar and bsdtar hosts, and never writes the archive to disk.
 *
 * Parsing is **fail-closed**. A header whose checksum does not verify, whose numeric fields are not
 * plain octal, or whose declared size runs past the end of the archive is a `throw`, not a member
 * that quietly reads as size 0 — a malformed archive must not produce a member list that disagrees
 * with what an extractor would do.
 *
 * Node built-ins only: this runs in the privileged publish job.
 */
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

/** POSIX ustar typeflags, named. */
export const TAR_TYPES = Object.freeze({
  0: "file",
  "\0": "file",
  1: "hardlink",
  2: "symlink",
  3: "character-device",
  4: "block-device",
  5: "directory",
  6: "fifo",
  7: "contiguous-file",
  x: "pax-extended-header",
  g: "pax-global-header",
  L: "gnu-long-name",
  K: "gnu-long-link-name",
});

function text(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

/**
 * A ustar numeric field: octal digits, optionally padded, terminated by NUL and/or space.
 *
 * GNU's base-256 extension (high bit set on the first byte) is refused rather than decoded. No
 * `npm pack` output needs it — it exists for sizes and ids beyond the octal range — and a silent
 * `0` here would let a member's body be skipped over as if it were empty.
 */
function octal(buffer, start, length, field) {
  const raw = buffer.subarray(start, start + length);
  if (raw.length > 0 && (raw[0] & 0x80) !== 0) {
    throw new Error(`tar header ${field} uses the GNU base-256 encoding, which is not supported`);
  }
  const digits = text(buffer, start, length).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) {
    throw new Error(`tar header ${field} is not a valid octal field`);
  }
  return Number.parseInt(digits, 8);
}

/** The ustar header checksum: every byte, with the checksum field itself read as spaces. */
function headerChecksum(header) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

/**
 * @param {Buffer|Uint8Array} gzipBytes  the `.tgz` contents
 * @returns {{name: string, type: string, typeflag: string, linkname: string, size: number,
 *   mode: number, prefix: string}[]}
 * @throws on a truncated, mis-checksummed, or otherwise malformed archive
 */
export function readTarMembers(gzipBytes) {
  const tar = gunzipSync(gzipBytes);
  const members = [];
  let offset = 0;

  while (offset < tar.length) {
    if (offset + BLOCK > tar.length) {
      throw new Error("tar archive ends in a truncated header block");
    }
    const header = tar.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop reading headers.
    if (header.every((byte) => byte === 0)) break;

    const declared = octal(header, 148, 8, "checksum");
    if (declared !== headerChecksum(header)) {
      throw new Error("tar header checksum does not verify");
    }

    const name = text(header, 0, 100);
    const size = octal(header, 124, 12, "size");
    const typeflag = String.fromCharCode(header[156]);
    const prefix = text(header, 345, 155);

    const bodyBlocks = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + BLOCK + bodyBlocks > tar.length) {
      throw new Error(
        `tar member ${name || "(unnamed)"} declares a size past the end of the archive`,
      );
    }

    members.push({
      name: prefix === "" ? name : `${prefix}/${name}`,
      type: TAR_TYPES[typeflag] ?? "unknown",
      typeflag,
      linkname: text(header, 157, 100),
      size,
      mode: octal(header, 100, 8, "mode"),
      prefix,
    });

    offset += BLOCK + bodyBlocks;
  }

  return members;
}
