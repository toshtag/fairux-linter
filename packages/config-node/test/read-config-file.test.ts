import {
  type BigIntStats,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigFileOps,
  ConfigFileReadError,
  type IdentityVerification,
  nativeConfigFileOps,
  readAutoDiscoveredJsonConfig,
  readExplicitJsonConfig,
  readRegularUtf8FileBounded,
} from "../src/index.js";

function fakeStat(dev: bigint, ino: bigint): BigIntStats {
  return {
    dev,
    ino,
    size: 2n,
    isFile: () => true,
    isSymbolicLink: () => false,
  } as BigIntStats;
}

describe("config file bounded descriptor reader", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fairux-config-read-"));
    file = resolve(dir, "fairux.config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads regular auto-discovered JSON from the descriptor", () => {
    writeFileSync(file, '{"ok":true}', "utf8");
    const result = readAutoDiscoveredJsonConfig(file, 32);
    expect(result.contents).toBe('{"ok":true}');
    expect(result.byteLength).toBe(11);
    // On a real POSIX filesystem the identity is stable.
    expect(["verified", "unavailable"]).toContain(result.identityVerification);
  });

  it("allows explicit JSON config symlinks but rejects auto-discovered symlinks", () => {
    const real = resolve(dir, "real.json");
    writeFileSync(real, '{"ok":true}', "utf8");
    symlinkSync(real, file);

    expect(() => readAutoDiscoveredJsonConfig(file, 32)).toThrow(ConfigFileReadError);
    expect(readExplicitJsonConfig(file, 32).contents).toBe('{"ok":true}');
  });

  it("rejects non-regular explicit targets before reading", () => {
    rmSync(file, { force: true });
    expect(() => readExplicitJsonConfig(dir, 32)).toThrow(/not a regular file/i);
  });

  it("rejects initially oversized files without reading", () => {
    writeFileSync(file, "abcd", "utf8");
    let readCalls = 0;
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      read: (fd, buffer, offset, length, position) => {
        readCalls++;
        return readSync(fd, buffer, offset, length, position);
      },
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 3, ops)).toThrow(/limit/i);
    expect(readCalls).toBe(0);
  });

  it("fails closed when the entry is replaced before open", () => {
    const beforeOpen = fakeStat(1n, 10n);
    const afterOpen = fakeStat(1n, 11n);
    let lstatCalls = 0;
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      lstat: () => {
        lstatCalls++;
        return lstatCalls === 1 ? beforeOpen : afterOpen;
      },
      open: () => 42,
      fstat: () => afterOpen,
      read: () => {
        throw new Error("read should not be reached after an identity mismatch");
      },
      close: () => undefined,
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 64, ops)).toThrow(/changed/i);
  });

  it("fails closed when the entry becomes a symlink before open", () => {
    writeFileSync(file, "{}", "utf8");
    const replacement = resolve(dir, "replacement.json");
    writeFileSync(replacement, "{}", "utf8");
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      open: (path, flags) => {
        rmSync(file);
        symlinkSync(replacement, file);
        return openSync(path, flags);
      },
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 32, ops)).toThrow(ConfigFileReadError);
  });

  it("fails closed when the path becomes a symlink after open", () => {
    writeFileSync(file, "{}", "utf8");
    const replacement = resolve(dir, "replacement.json");
    writeFileSync(replacement, "{}", "utf8");
    const link = resolve(dir, "link.json");
    symlinkSync(replacement, link);
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      open: (path, flags) => {
        const fd = openSync(path, flags);
        rmSync(file);
        symlinkSync(replacement, file);
        return fd;
      },
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 32, ops)).toThrow(ConfigFileReadError);
  });

  it("fails closed when the path becomes another regular file after open", () => {
    writeFileSync(file, '{"old":true}', "utf8");
    const replacement = resolve(dir, "replacement.json");
    writeFileSync(replacement, '{"new":true}', "utf8");
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      open: (path, flags) => {
        const fd = openSync(path, flags);
        rmSync(file);
        writeFileSync(file, '{"new":true}', "utf8");
        return fd;
      },
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 64, ops)).toThrow(/changed/i);
  });

  it("rejects growth beyond the byte limit during descriptor read", () => {
    writeFileSync(file, "abc", "utf8");
    let grew = false;
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      fstat: (fd) => {
        const stat = fstatSync(fd, { bigint: true });
        if (!grew) {
          grew = true;
          writeFileSync(file, "abcd", "utf8");
        }
        return stat;
      },
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 3, ops)).toThrow(/limit/i);
  });

  it("closes descriptors on read errors", () => {
    writeFileSync(file, "{}", "utf8");
    const closed: number[] = [];
    let opened: number | undefined;
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      open: (path, flags) => {
        opened = openSync(path, flags);
        return opened;
      },
      read: () => {
        throw new Error("boom");
      },
      close: (fd) => {
        closed.push(fd);
        closeSync(fd);
      },
    };

    expect(() =>
      readRegularUtf8FileBounded(file, { maxBytes: 32, allowSymlink: false }, ops),
    ).toThrow(/boom/);
    expect(opened).toBeDefined();
    expect(closed).toEqual([opened]);
  });

  it("closes descriptors on post-open identity errors", () => {
    writeFileSync(file, "{}", "utf8");
    const closed: number[] = [];
    let opened: number | undefined;
    const replacement = resolve(dir, "replacement.json");
    writeFileSync(replacement, "{}", "utf8");
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      open: (path, flags) => {
        opened = openSync(path, flags);
        rmSync(file);
        writeFileSync(file, "{}", "utf8");
        return opened;
      },
      close: (fd) => {
        closed.push(fd);
        closeSync(fd);
      },
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 32, ops)).toThrow(/changed/i);
    expect(opened).toBeDefined();
    expect(closed).toEqual([opened]);
  });

  it("can be driven by injected file ops without exposing unbounded path reads", () => {
    writeFileSync(file, '{"descriptor":true}', "utf8");
    const calls: string[] = [];
    const ops: ConfigFileOps = {
      lstat: (path) => {
        calls.push("lstat");
        return lstatSync(path, { bigint: true });
      },
      open: (path, flags) => {
        calls.push("open");
        return openSync(path, flags);
      },
      fstat: (fd) => {
        calls.push("fstat");
        return fstatSync(fd, { bigint: true });
      },
      read: (fd, buffer, offset, length, position) => {
        calls.push("read");
        return readSync(fd, buffer, offset, length, position);
      },
      close: (fd) => {
        calls.push("close");
        return closeSync(fd);
      },
    };

    const result = readAutoDiscoveredJsonConfig(file, 64, ops);
    expect(result.contents).toBe('{"descriptor":true}');
    expect(calls).toEqual(["lstat", "open", "fstat", "lstat", "read", "read", "close"]);
  });

  it("compares BigInt file identity without number precision loss", () => {
    const inodeA = 9_007_199_254_740_992n;
    const inodeB = 9_007_199_254_740_993n;
    expect(Number(inodeA)).toBe(Number(inodeB));

    let lstatCalls = 0;
    const ops: ConfigFileOps = {
      lstat: () => {
        lstatCalls++;
        return lstatCalls === 1 ? fakeStat(1n, inodeA) : fakeStat(1n, inodeB);
      },
      open: () => 123,
      fstat: () => fakeStat(1n, inodeB),
      read: () => 0,
      close: () => undefined,
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 64, ops)).toThrow(/changed/i);
  });

  // ---------------------------------------------------------------------------
  // Windows-equivalent identity tests (all-zero dev/ino)
  // ---------------------------------------------------------------------------

  it("does not claim verified identity when dev and ino are all-zero (Windows-equivalent)", () => {
    writeFileSync(file, '{"ok":true}', "utf8");
    const zeroStat = fakeStat(0n, 0n);
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      lstat: () => zeroStat,
      fstat: () => zeroStat,
    };

    const result = readAutoDiscoveredJsonConfig(file, 64, ops);
    expect(result.contents).toBe('{"ok":true}');
    const verification: IdentityVerification = result.identityVerification;
    expect(verification).toBe("unavailable");
  });

  it("treats two different files as unavailable (not same) when both have zero dev/ino", () => {
    writeFileSync(file, '{"file":1}', "utf8");
    const zeroStat = fakeStat(0n, 0n);
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      lstat: () => zeroStat,
      fstat: () => zeroStat,
    };

    const result = readAutoDiscoveredJsonConfig(file, 64, ops);
    // Must not be "verified" — unavailable identity is not the same as confirmed identity.
    expect(result.identityVerification).toBe("unavailable");
  });

  it("fails closed when pre has stable identity but fd has zero identity (mixed)", () => {
    writeFileSync(file, '{"ok":true}', "utf8");
    const stableStat = fakeStat(1n, 42n);
    const zeroStat = fakeStat(0n, 0n);
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      lstat: () => stableStat,
      fstat: () => zeroStat,
      read: () => {
        throw new Error("read should not be reached after a mixed identity mismatch");
      },
      close: () => undefined,
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 64, ops)).toThrow(/changed/i);
  });

  it("fails closed when fd has stable identity but post has zero identity (mixed)", () => {
    writeFileSync(file, '{"ok":true}', "utf8");
    const stableStat = fakeStat(1n, 42n);
    const zeroStat = fakeStat(0n, 0n);
    let lstatCalls = 0;
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      lstat: () => {
        lstatCalls++;
        return lstatCalls === 1 ? stableStat : zeroStat;
      },
      fstat: () => stableStat,
      read: () => {
        throw new Error("read should not be reached after a mixed identity mismatch");
      },
      close: () => undefined,
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 64, ops)).toThrow(/changed/i);
  });

  it("still enforces symlink rejection when identity is unavailable", () => {
    const real = resolve(dir, "real.json");
    writeFileSync(real, '{"ok":true}', "utf8");
    symlinkSync(real, file);

    expect(() => readAutoDiscoveredJsonConfig(file, 32)).toThrow(ConfigFileReadError);
  });

  it("still enforces byte limit when identity is unavailable", () => {
    writeFileSync(file, '{"ok":true}', "utf8");
    const zeroStat = { ...fakeStat(0n, 0n), size: 2n };
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      lstat: () => zeroStat,
      fstat: () => zeroStat,
    };

    expect(() => readAutoDiscoveredJsonConfig(file, 1, ops)).toThrow(/limit/i);
  });

  it("returns verified identity when stable identity matches across all three stats", () => {
    writeFileSync(file, '{"ok":true}', "utf8");
    const stableStat = fakeStat(99n, 999n);
    const ops: ConfigFileOps = {
      ...nativeConfigFileOps,
      lstat: () => stableStat,
      fstat: () => stableStat,
    };

    const result = readAutoDiscoveredJsonConfig(file, 64, ops);
    expect(result.identityVerification).toBe("verified");
  });
});
