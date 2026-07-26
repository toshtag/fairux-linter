import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The workspace boundary is enforced by TypeScript, not by a script.
 *
 * `rootDir` on a package's typecheck project means every file in that program must live under the
 * package; reaching into another workspace's `src` pulls foreign files in and `tsc` reports TS6059.
 * That is the exact invariant issue #57 needed, and unlike a source scanner it cannot be evaded by
 * how an import is written — a string, comment, regex, or JSX text that merely *looks* like an
 * import never enters the program in the first place.
 *
 * These assertions exist so the settings cannot be dropped silently. Without `rootDir` the
 * projects still typecheck clean, so nothing else would notice.
 */

const root = resolve(import.meta.dirname, "../..");

/** Our tsconfigs are JSONC with whole-line `//` comments; `$schema` URLs make a naive strip wrong. */
function readTsconfig(relativePath: string): {
  compilerOptions?: { rootDir?: string; noEmit?: boolean; outDir?: string };
  include?: string[];
  extends?: string;
} {
  const text = readFileSync(resolve(root, relativePath), "utf8");
  const withoutComments = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(withoutComments);
}

function workspaceDirs(): string[] {
  return ["packages", "apps"]
    .flatMap((group) =>
      readdirSync(resolve(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${group}/${entry.name}`),
    )
    .sort();
}

const workspaces = workspaceDirs();

describe("package boundary — typecheck projects", () => {
  it("covers every workspace", () => {
    expect(workspaces.length).toBeGreaterThanOrEqual(12);
  });

  it.each(workspaces)("%s pins rootDir to the package root", (dir) => {
    const config = readTsconfig(`${dir}/tsconfig.json`);
    expect(config.compilerOptions?.rootDir).toBe(".");
  });

  it.each(workspaces)("%s typechecks without emitting", (dir) => {
    // Inherited from tsconfig.base.json; asserted here so a local override cannot re-arm emit.
    const config = readTsconfig(`${dir}/tsconfig.json`);
    expect(config.extends).toBe("../../tsconfig.base.json");
    expect(config.compilerOptions?.noEmit).not.toBe(false);
  });

  it("keeps the shared base emit-free", () => {
    expect(readTsconfig("tsconfig.base.json").compilerOptions?.noEmit).toBe(true);
  });
});

describe("package boundary — declaration emit projects", () => {
  const emitProjects = workspaces.filter((dir) => {
    try {
      readTsconfig(`${dir}/tsconfig.build.json`);
      return true;
    } catch {
      return false;
    }
  });

  it("exists for every package that emits declarations", () => {
    // apps/cli and apps/chrome-extension build with `dts: false` and have no declaration program.
    expect(emitProjects).not.toContain("apps/cli");
    expect(emitProjects).not.toContain("apps/chrome-extension");
    expect(emitProjects.length).toBe(workspaces.length - 2);
  });

  it.each(emitProjects)("%s scopes the emit program to src", (dir) => {
    const config = readTsconfig(`${dir}/tsconfig.build.json`);
    expect(config.extends).toBe("./tsconfig.json");
    expect(config.include).toEqual(["src"]);
    expect(config.compilerOptions?.rootDir).toBe("src");
    expect(config.compilerOptions?.noEmit).toBe(false);
    expect(config.compilerOptions?.outDir).toBe("dist");
  });
});
