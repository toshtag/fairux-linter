/**
 * Read a gzipped tar's member headers without extracting it.
 *
 * The packed-tarball audits used `tar -tzf`, which prints names and nothing else. A name is not
 * enough to know what a member *is*: `dist/index.js` may be a symlink to `/etc/passwd`, a hardlink,
 * or a device node, and every one of those lists as `dist/index.js`. Names also arrive already
 * normalized by the tar implementation, so `package/../../evil` may or may not survive to be seen.
 *
 * Reading the 512-byte headers ourselves gives the typeflag and link target verbatim, identically
 * on GNU tar and bsdtar hosts, and never writes the archive to disk.
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

function octal(buffer, start, length) {
  const raw = text(buffer, start, length).trim();
  return raw === "" ? 0 : Number.parseInt(raw, 8) || 0;
}

/**
 * @param {Buffer|Uint8Array} gzipBytes  the `.tgz` contents
 * @returns {{name: string, type: string, typeflag: string, linkname: string, size: number,
 *   mode: number, prefix: string}[]}
 */
export function readTarMembers(gzipBytes) {
  const tar = gunzipSync(gzipBytes);
  const members = [];
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop reading headers.
    if (header.every((byte) => byte === 0)) break;

    const name = text(header, 0, 100);
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const prefix = text(header, 345, 155);

    members.push({
      name: prefix === "" ? name : `${prefix}/${name}`,
      type: TAR_TYPES[typeflag] ?? "unknown",
      typeflag,
      linkname: text(header, 157, 100),
      size,
      mode: octal(header, 100, 8),
      prefix,
    });

    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }

  return members;
}
