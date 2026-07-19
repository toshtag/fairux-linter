import { closeSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigFileReadError,
  nativeConfigFileOps,
  readAutoDiscoveredJsonConfig,
} from "../src/index.js";

/**
 * Windows-native config file integration tests.
 *
 * These tests run on all platforms using native filesystem ops so that Windows
 * CI can exercise the actual BigIntStats values the OS returns. On POSIX the
 * tests remain valid but identity will be "verified"; on Windows dev/ino may
 * be 0n so identity will be "unavailable". Both outcomes are correct and
 * asserted here.
 */
describe("windows-native config file integration", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fairux-win-config-"));
    file = resolve(dir, "fairux.config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a plain auto-discovered JSON config successfully", () => {
    writeFileSync(file, '{"configVersion":1}', "utf8");
    const result = readAutoDiscoveredJsonConfig(file, 64 * 1024);
    expect(result.contents).toBe('{"configVersion":1}');
    expect(result.byteLength).toBe(19);
  });

  it("reports the native BigIntStats dev and ino values without crashing", () => {
    writeFileSync(file, "{}", "utf8");
    const stat = nativeConfigFileOps.lstat(file);
    // On Windows dev and ino may be 0n; on POSIX they are non-zero.
    // Either way they must be bigints.
    expect(typeof stat.dev).toBe("bigint");
    expect(typeof stat.ino).toBe("bigint");
  });

  it("identityVerification is either verified or unavailable (never a third value)", () => {
    writeFileSync(file, '{"configVersion":1}', "utf8");
    const result = readAutoDiscoveredJsonConfig(file, 64 * 1024);
    expect(["verified", "unavailable"]).toContain(result.identityVerification);
  });

  it("still performs a bounded descriptor read regardless of identity availability", () => {
    const payload = "x".repeat(10);
    writeFileSync(file, payload, "utf8");
    const result = readAutoDiscoveredJsonConfig(file, 64 * 1024);
    expect(result.byteLength).toBe(10);
  });

  it("rejects a config that exceeds the byte limit on Windows paths", () => {
    writeFileSync(file, "a".repeat(5), "utf8");
    expect(() => readAutoDiscoveredJsonConfig(file, 4)).toThrow(/limit/i);
  });

  it("rejects a config that grows beyond the limit during descriptor read", () => {
    writeFileSync(file, "ab", "utf8");
    let grew = false;
    const ops = {
      ...nativeConfigFileOps,
      fstat: (fd: number) => {
        const stat = nativeConfigFileOps.fstat(fd);
        if (!grew) {
          grew = true;
          writeFileSync(file, "abcd", "utf8");
        }
        return stat;
      },
    };
    expect(() => readAutoDiscoveredJsonConfig(file, 2, ops)).toThrow(/limit/i);
  });

  it("auto-discovered symlinks are rejected when symlinks can be created", () => {
    const real = resolve(dir, "real.json");
    writeFileSync(real, '{"ok":true}', "utf8");

    let canCreateSymlink = true;
    try {
      symlinkSync(real, file);
    } catch {
      canCreateSymlink = false;
    }

    if (!canCreateSymlink) {
      // Skip symlink assertion only — ordinary read tests above still ran.
      return;
    }

    expect(() => readAutoDiscoveredJsonConfig(file, 32)).toThrow(ConfigFileReadError);
  });

  it("fails closed on native regular-file replacement when stable identity is available", () => {
    writeFileSync(file, '{"old":true}', "utf8");
    const baseline = readAutoDiscoveredJsonConfig(file, 64);

    if (baseline.identityVerification === "unavailable") {
      // Windows may expose all-zero dev/ino. In that case replacement detection
      // is not claimed; the other native boundary tests in this file still run.
      expect(baseline.contents).toBe('{"old":true}');
      return;
    }

    const replacement = resolve(dir, "replacement.json");
    writeFileSync(replacement, '{"new":true}', "utf8");
    const ops = {
      ...nativeConfigFileOps,
      open: (path: import("node:fs").PathLike, flags: number) => {
        const fd = nativeConfigFileOps.open(path, flags);
        rmSync(file);
        writeFileSync(file, '{"new":true}', "utf8");
        return fd;
      },
    };
    expect(() => readAutoDiscoveredJsonConfig(file, 64, ops)).toThrow(ConfigFileReadError);
  });

  it("descriptor is always closed on native read errors", () => {
    writeFileSync(file, "{}", "utf8");
    const closed: number[] = [];
    let opened: number | undefined;
    const ops = {
      ...nativeConfigFileOps,
      open: (path: import("node:fs").PathLike, flags: number): number => {
        opened = openSync(path, flags);
        return opened;
      },
      read: () => {
        throw new Error("native read failure");
      },
      close: (fd: number) => {
        closed.push(fd);
        closeSync(fd);
      },
    };
    expect(() => readAutoDiscoveredJsonConfig(file, 32, ops)).toThrow(/native read failure/);
    expect(opened).toBeDefined();
    expect(closed).toEqual([opened]);
  });
});
