import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedCliBinPath } from "../../apps/cli/scripts/installed-cli-smoke-contract.mjs";

/**
 * `node_modules/.bin/fairux` is the POSIX half of an answer that used to be written as the whole
 * one. On Windows npm writes three shims side by side — `fairux` (a shell script for MSYS), plus
 * `fairux.cmd` and `fairux.ps1` — and the extensionless one is not what `cmd.exe` or a plain
 * `spawn` runs. The packed smoke test asserted `existsSync` on that path and then executed it, so
 * on Windows it would have found a file and run the wrong thing, or nothing.
 */

let projectDir: string;
let binDir: string;

const IS_WINDOWS = process.platform === "win32";

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fairux-bin-"));
  binDir = join(projectDir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("installedCliBinPath", () => {
  it("finds the shim npm generates for this platform", () => {
    const expected = IS_WINDOWS ? "fairux.cmd" : "fairux";
    writeFileSync(join(binDir, expected), "", "utf8");
    expect(installedCliBinPath(projectDir)).toBe(join(binDir, expected));
  });

  it("refuses to report a bin when npm generated none", () => {
    // The caller must not quietly fall back to `node dist/index.js`: that runs the bundle while
    // saying nothing about whether the published `bin` entry produced a working executable.
    expect(() => installedCliBinPath(projectDir)).toThrow(/no npm-generated fairux shim/);
  });

  it.skipIf(IS_WINDOWS)("uses the extensionless shim on POSIX", () => {
    writeFileSync(join(binDir, "fairux"), "", "utf8");
    expect(installedCliBinPath(projectDir)).toBe(join(binDir, "fairux"));
  });

  it.skipIf(!IS_WINDOWS)("prefers the .cmd shim over the MSYS shell script on Windows", () => {
    writeFileSync(join(binDir, "fairux"), "#!/bin/sh\n", "utf8");
    writeFileSync(join(binDir, "fairux.cmd"), "@ECHO OFF\n", "utf8");
    expect(installedCliBinPath(projectDir)).toBe(join(binDir, "fairux.cmd"));
  });

  it("resolves a differently named bin the same way", () => {
    const expected = IS_WINDOWS ? "other.cmd" : "other";
    writeFileSync(join(binDir, expected), "", "utf8");
    expect(installedCliBinPath(projectDir, "other")).toBe(join(binDir, expected));
  });
});
