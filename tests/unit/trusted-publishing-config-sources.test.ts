import { describe, expect, it, vi } from "vitest";
import { collectNpmConfigSources } from "../../scripts/trusted-publishing-config-sources.mjs";

/**
 * The collector is the half that regressed silently.
 *
 * The evaluator was well tested, but its tests handed it config sources directly — so a collector
 * that read only the user config still passed everything, which is exactly what happened. These
 * tests inject the filesystem and `npm config get` so the collection itself is asserted.
 */

const fsError = (code: string) => {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
};

/** A collector wired to an in-memory filesystem; missing paths throw ENOENT like `readFileSync`. */
function collect(files: Record<string, string | Error>, config: Record<string, string> = {}) {
  const readFile = vi.fn((path: string) => {
    const entry = files[path];
    if (entry === undefined) throw fsError("ENOENT");
    if (entry instanceof Error) throw entry;
    return entry;
  });
  const npmConfigGet = vi.fn((key: string) => config[key] ?? "");
  const sources = collectNpmConfigSources({
    cwd: "/repo",
    npmConfigGet,
    readFile,
    resolvePath: (path: string) => path,
  });
  return { sources, readFile, npmConfigGet };
}

describe("npm config sources — collection", () => {
  it("collects project, user, and global", () => {
    const { sources, npmConfigGet } = collect(
      {
        "/repo/.npmrc": "registry=https://registry.npmjs.org/\n",
        "/home/u/.npmrc": "provenance=true\n",
        "/etc/npmrc": "auth-type=web\n",
      },
      { userconfig: "/home/u/.npmrc", globalconfig: "/etc/npmrc" },
    );

    expect(sources.map((source) => source.kind)).toEqual(["project", "user", "global"]);
    expect(sources.map((source) => source.path)).toEqual([
      "/repo/.npmrc",
      "/home/u/.npmrc",
      "/etc/npmrc",
    ]);
    // The project file is derived from cwd, not asked of npm; the other two are.
    expect(npmConfigGet).toHaveBeenCalledWith("userconfig");
    expect(npmConfigGet).toHaveBeenCalledWith("globalconfig");
  });

  it("honours a custom userconfig and globalconfig path", () => {
    const { sources } = collect(
      { "/custom/user.npmrc": "a=b\n", "/custom/global.npmrc": "c=d\n" },
      { userconfig: "/custom/user.npmrc", globalconfig: "/custom/global.npmrc" },
    );
    expect(sources.map((source) => source.path)).toEqual([
      "/custom/user.npmrc",
      "/custom/global.npmrc",
    ]);
  });

  it("reads a duplicated path once, keeping the more specific kind", () => {
    const { sources, readFile } = collect(
      { "/repo/.npmrc": "registry=x\n" },
      { userconfig: "/repo/.npmrc", globalconfig: "/repo/.npmrc" },
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("project");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("ignores files that do not exist", () => {
    const { sources } = collect(
      { "/home/u/.npmrc": "registry=x\n" },
      { userconfig: "/home/u/.npmrc", globalconfig: "/etc/npmrc" },
    );
    expect(sources.map((source) => source.kind)).toEqual(["user"]);
  });

  it("ignores an unset, undefined, or null config path", () => {
    for (const value of ["", "undefined", "null"]) {
      const { sources } = collect({}, { userconfig: value, globalconfig: value });
      expect(sources, value).toEqual([]);
    }
  });

  it("returns nothing when no config exists anywhere", () => {
    expect(collect({}, { userconfig: "/home/u/.npmrc" }).sources).toEqual([]);
  });
});

describe("npm config sources — fail closed", () => {
  it.each(["EACCES", "EISDIR", "EIO", "EMFILE"])("throws on %s rather than skipping", (code) => {
    expect(() => collect({ "/repo/.npmrc": fsError(code) })).toThrow(/Cannot read the project/);
    expect(() => collect({ "/repo/.npmrc": fsError(code) })).toThrow(new RegExp(code));
  });

  it("names the offending path and kind", () => {
    expect(() =>
      collect({ "/etc/npmrc": fsError("EACCES") }, { globalconfig: "/etc/npmrc" }),
    ).toThrow(/global npm config at \/etc\/npmrc/);
  });

  it("does not put config contents in the error", () => {
    const secret = "npm_secretInAnUnreadableFile";
    const error = fsError("EACCES");
    error.message = `EACCES while reading ${secret}`;
    let caught = "";
    try {
      collect({ "/repo/.npmrc": error });
    } catch (thrown) {
      caught = (thrown as Error).message;
    }
    expect(caught).toContain("Cannot read the project");
    expect(caught).not.toContain(secret);
  });
});
