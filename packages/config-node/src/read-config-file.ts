import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  type PathLike,
  readSync,
} from "node:fs";

export type ConfigFileReadFailureReason =
  | "absent"
  | "symlink-or-irregular"
  | "oversized"
  | "changed-during-read"
  | "read-failed";

export class ConfigFileReadError extends Error {
  constructor(
    public readonly reason: ConfigFileReadFailureReason,
    message: string,
    public readonly actualBytes?: number | bigint,
  ) {
    super(message);
    this.name = "ConfigFileReadError";
  }
}

export interface ConfigFileOps {
  lstat(path: PathLike): BigIntStats;
  open(path: PathLike, flags: number): number;
  fstat(fd: number): BigIntStats;
  read(
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  close(fd: number): void;
}

export interface ReadRegularFileOptions {
  maxBytes: number;
  allowSymlink: boolean;
}

export type IdentityVerification = "verified" | "unavailable";

export interface ReadRegularFileResult {
  contents: string;
  byteLength: number;
  identityVerification: IdentityVerification;
}

export const nativeConfigFileOps: ConfigFileOps = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path, flags) => openSync(path, flags),
  fstat: (fd) => fstatSync(fd, { bigint: true }),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
};

export function readRegularUtf8FileBounded(
  filePath: string,
  options: ReadRegularFileOptions,
  ops: ConfigFileOps = nativeConfigFileOps,
): ReadRegularFileResult {
  const preStat = lstatForRead(filePath, ops, options.allowSymlink);
  if (!options.allowSymlink) {
    assertPlainRegularFile(preStat);
    assertWithinInitialLimit(preStat, options.maxBytes);
  } else {
    assertExplicitOpenableEntry(preStat);
    if (!preStat.isSymbolicLink()) {
      assertWithinInitialLimit(preStat, options.maxBytes);
    }
  }

  let fd: number | undefined;
  try {
    fd = ops.open(filePath, openFlags(options.allowSymlink));
    const fdStat = ops.fstat(fd);
    assertPlainRegularFile(fdStat);
    assertWithinInitialLimit(fdStat, options.maxBytes);

    let identityVerification: IdentityVerification = "unavailable";

    if (!options.allowSymlink) {
      const preToFd = compareFileIdentity(preStat, fdStat);
      if (preToFd === "different") {
        throw changedDuringReadError();
      }

      const postStat = lstatForRead(filePath, ops, false);
      assertPlainRegularFile(postStat);
      const fdToPost = compareFileIdentity(fdStat, postStat);
      if (fdToPost === "different") {
        throw changedDuringReadError();
      }

      if (preToFd === "same" && fdToPost === "same") {
        identityVerification = "verified";
      }
    }

    const descriptorResult = readDescriptorUtf8Bounded(fd, options.maxBytes, ops);
    return { ...descriptorResult, identityVerification };
  } catch (error) {
    if (error instanceof ConfigFileReadError) throw error;
    throw new ConfigFileReadError("read-failed", readErrorMessage(error));
  } finally {
    if (fd !== undefined) {
      try {
        ops.close(fd);
      } catch {
        // Nothing useful can be reported after the primary read result.
      }
    }
  }
}

export function readAutoDiscoveredJsonConfig(
  filePath: string,
  maxBytes: number,
  ops?: ConfigFileOps,
): ReadRegularFileResult {
  return readRegularUtf8FileBounded(filePath, { maxBytes, allowSymlink: false }, ops);
}

export function readExplicitJsonConfig(
  filePath: string,
  maxBytes: number,
  ops?: ConfigFileOps,
): ReadRegularFileResult {
  return readRegularUtf8FileBounded(filePath, { maxBytes, allowSymlink: true }, ops);
}

// ---------------------------------------------------------------------------
// File identity helpers
//
// Node.js BigIntStats.dev and .ino are the canonical way to compare filesystem
// entries. On POSIX these are non-zero and stable. On Windows, however, Node.js
// returns 0n for both fields (the underlying NTFS FileId is not exposed through
// the standard stat call), so two completely different files are
// indistinguishable by dev/ino alone.
//
// Rather than branching on process.platform, we inspect the values themselves:
// if both dev and ino are 0n we treat identity as "unavailable". The caller then
// decides: a "different" result fails closed; an "unavailable" result means the
// OS cannot provide a replacement-detection guarantee, so we skip that claim but
// continue enforcing all other boundaries (non-symlink, regular-file, byte
// limit, descriptor-bound read, JSON-only parsing, strict validation).
// ---------------------------------------------------------------------------

interface StableFileIdentity {
  kind: "stable";
  dev: bigint;
  ino: bigint;
}

interface UnavailableFileIdentity {
  kind: "unavailable";
}

type FileIdentity = StableFileIdentity | UnavailableFileIdentity;

type IdentityComparison = "same" | "different" | "unavailable";

function fileIdentity(stat: BigIntStats): FileIdentity {
  if (stat.dev === 0n && stat.ino === 0n) {
    return { kind: "unavailable" };
  }
  return { kind: "stable", dev: stat.dev, ino: stat.ino };
}

function compareFileIdentity(left: BigIntStats, right: BigIntStats): IdentityComparison {
  const a = fileIdentity(left);
  const b = fileIdentity(right);

  if (a.kind === "unavailable" && b.kind === "unavailable") {
    return "unavailable";
  }

  if (a.kind !== b.kind) {
    // One side is stable, the other is not — treat as changed.
    return "different";
  }

  if (a.kind === "stable" && b.kind === "stable") {
    return a.dev === b.dev && a.ino === b.ino ? "same" : "different";
  }

  return "unavailable";
}

function lstatForRead(filePath: string, ops: ConfigFileOps, allowSymlink: boolean): BigIntStats {
  try {
    return ops.lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new ConfigFileReadError("absent", `Config file not found: ${filePath}`);
    }
    if (!allowSymlink) {
      throw new ConfigFileReadError("read-failed", readErrorMessage(error));
    }
    throw error;
  }
}

function assertPlainRegularFile(stat: BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ConfigFileReadError(
      "symlink-or-irregular",
      "Config file must be a regular, non-symlink file.",
    );
  }
}

function assertExplicitOpenableEntry(stat: BigIntStats): void {
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    throw new ConfigFileReadError("symlink-or-irregular", "Config file is not a regular file.");
  }
}

function assertWithinInitialLimit(stat: BigIntStats, maxBytes: number): void {
  if (stat.size > BigInt(maxBytes)) {
    throw new ConfigFileReadError(
      "oversized",
      `Config file exceeds the ${maxBytes}-byte limit.`,
      stat.size,
    );
  }
}

function readDescriptorUtf8Bounded(
  fd: number,
  maxBytes: number,
  ops: ConfigFileOps,
): { contents: string; byteLength: number } {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const bytesRead = ops.read(fd, buffer, 0, Math.min(buffer.length, remaining), null);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new ConfigFileReadError(
      "oversized",
      `Config file exceeds the ${maxBytes}-byte limit.`,
      total,
    );
  }
  return {
    contents: Buffer.concat(chunks, total).toString("utf8"),
    byteLength: total,
  };
}

function changedDuringReadError(): ConfigFileReadError {
  return new ConfigFileReadError(
    "changed-during-read",
    "Config file changed while being inspected.",
  );
}

function openFlags(allowSymlink: boolean): number {
  const noFollow = allowSymlink ? 0 : (constants.O_NOFOLLOW ?? 0);
  return constants.O_RDONLY | noFollow;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
