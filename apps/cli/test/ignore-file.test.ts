import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IgnoreFileError, loadIgnoreFile, noIgnore, parseIgnoreFile } from "../src/ignore-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

function withTempDir<T>(prefix: string, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a matcher over a temporary base without touching the filesystem for each case. */
function matcher(base: string, contents: string) {
  return withTempDir("fairux-ignore-", (dir) => {
    writeFileSync(join(dir, ".fairuxignore"), contents, "utf8");
    const loaded = loadIgnoreFile(dir);
    const at = (relativePath: string, isDirectory = false) =>
      loaded.ignores(join(dir, relativePath), isDirectory);
    return { at, unused: () => loaded.unusedPatterns(), base: dir };
  });
}

describe(".fairuxignore patterns", () => {
  it("ignores a bare name at any depth", () => {
    const { at } = matcher("", "dist\n");
    expect(at("dist/index.html")).toBe(true);
    expect(at("packages/app/dist/index.html")).toBe(true);
    expect(at("src/index.html")).toBe(false);
    // Not a prefix match: `distribution` is a different directory.
    expect(at("distribution/index.html")).toBe(false);
  });

  it("anchors a leading slash to the ignore file's directory", () => {
    const { at } = matcher("", "/dist\n");
    expect(at("dist/index.html")).toBe(true);
    expect(at("packages/app/dist/index.html")).toBe(false);
  });

  it("restricts a trailing slash to directories", () => {
    const { at } = matcher("", "build/\n");
    expect(at("build", true)).toBe(true);
    // A *file* called `build` is not what the pattern asked to exclude.
    expect(at("build", false)).toBe(false);
  });

  it("treats ** as any number of segments and * as one", () => {
    const single = matcher("", "vendor/*.html\n").at;
    expect(single("vendor/a.html")).toBe(true);
    expect(single("vendor/nested/a.html")).toBe(false);

    const deep = matcher("", "vendor/**\n").at;
    expect(deep("vendor/a.html")).toBe(true);
    expect(deep("vendor/nested/a.html")).toBe(true);

    const leading = matcher("", "**/fixtures\n").at;
    expect(leading("a/b/fixtures/x.html")).toBe(true);
    expect(leading("fixtures/x.html")).toBe(true);
  });

  it("lets a later negation re-include what an earlier line excluded", () => {
    const { at } = matcher("", "vendor/**\n!vendor/keep.html\n");
    expect(at("vendor/drop.html")).toBe(true);
    expect(at("vendor/keep.html")).toBe(false);
  });

  it("keeps last-match-wins, so order is the user's to control", () => {
    const reIncludedThenExcluded = matcher("", "!vendor/keep.html\nvendor/**\n").at;
    expect(reIncludedThenExcluded("vendor/keep.html")).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    const { at } = matcher("", "# generated\n\n  dist  \n");
    expect(at("dist/a.html")).toBe(true);
  });

  it("says nothing about paths outside its own directory", () => {
    const { at } = matcher("", "**\n");
    // `**` excludes everything *under* the base. A sibling directory is not the ignore file's
    // business, and treating it as excluded would let one file silence an unrelated scan.
    expect(at("../elsewhere/a.html")).toBe(false);
  });

  /**
   * Refused rather than approximated. A pattern this matcher would silently mis-handle is worse
   * than one it rejects: the user believes something is excluded and it is not.
   */
  it("refuses constructs it does not support, naming the line", () => {
    for (const contents of ["src/[abc].html\n", "src/a\\*.html\n", "!\n", "/\n"]) {
      expect(() => parseIgnoreFile(contents, "/tmp/.fairuxignore"), contents).toThrow(
        IgnoreFileError,
      );
    }
    try {
      parseIgnoreFile("dist\nsrc/[abc].html\n", "/tmp/.fairuxignore");
    } catch (error) {
      expect((error as Error).message).toContain(":2:");
    }
  });

  it("reports patterns that matched nothing", () => {
    const { at, unused } = matcher("", "dist\nnever-here\n");
    at("dist/a.html");
    expect(unused()).toEqual(["never-here"]);
  });

  it("excludes nothing when there is no ignore file, and under --no-ignore", () => {
    withTempDir("fairux-ignore-none-", (dir) => {
      expect(loadIgnoreFile(dir).ignores(join(dir, "dist/a.html"))).toBe(false);
      expect(loadIgnoreFile(dir).filePath).toBeUndefined();
      expect(noIgnore(dir).ignores(join(dir, "dist/a.html"))).toBe(false);
    });
  });
});

describe("fairux scan with .fairuxignore (end-to-end)", () => {
  const page = "<html><body><button>Buy now</button></body></html>";

  function fixture(dir: string, ignoreContents: string) {
    for (const sub of ["src", "dist", "vendor"]) mkdirSync(join(dir, sub), { recursive: true });
    for (const file of ["src/a.html", "src/keep.html", "dist/b.html", "vendor/c.html"]) {
      writeFileSync(join(dir, file), page, "utf8");
    }
    writeFileSync(join(dir, ".fairuxignore"), ignoreContents, "utf8");
  }

  const scanned = (result: { stdout: string }) => {
    const report = JSON.parse(result.stdout);
    const files: string[] = report.inputs
      ? report.inputs.map((input: { file: string }) => input.file)
      : [report.input.file];
    return files.map((file) => file.split("/").slice(-2).join("/")).sort();
  };

  const run = (args: string[], cwd: string) =>
    spawnSync("node", [cliBin, ...args], { encoding: "utf8", cwd, timeout: 20000 });

  it("prunes excluded directories from a walk and honours a negation", () => {
    withTempDir("fairux-ignore-e2e-", (dir) => {
      fixture(dir, "dist/\nvendor/**\n!vendor/c.html\n");
      const result = run(["scan", dir, "--format", "json", "--ignore-config"], dir);
      expect(result.status).toBe(0);
      expect(scanned(result)).toEqual(["src/a.html", "src/keep.html", "vendor/c.html"]);
    });
  });

  it("applies to a glob for the same reason it applies to a walk", () => {
    withTempDir("fairux-ignore-glob-", (dir) => {
      fixture(dir, "dist/\n");
      const result = run(["scan", "**/*.html", "--format", "json", "--ignore-config"], dir);
      expect(scanned(result)).not.toContain("dist/b.html");
    });
  });

  it("scans an explicitly named file even when it is ignored", () => {
    // Naming a file is an instruction. Silently doing nothing in response to one is the failure
    // this feature most risks.
    withTempDir("fairux-ignore-explicit-", (dir) => {
      fixture(dir, "dist/\n");
      const result = run(
        ["scan", join(dir, "dist", "b.html"), "--format", "json", "--ignore-config"],
        dir,
      );
      expect(result.status).toBe(0);
      expect(scanned(result)).toEqual(["dist/b.html"]);
    });
  });

  it("restores everything under --no-ignore", () => {
    withTempDir("fairux-ignore-off-", (dir) => {
      fixture(dir, "dist/\nvendor/**\n");
      const result = run(["scan", dir, "--format", "json", "--ignore-config", "--no-ignore"], dir);
      expect(scanned(result)).toEqual([
        "dist/b.html",
        "src/a.html",
        "src/keep.html",
        "vendor/c.html",
      ]);
    });
  });

  it("says the ignore file is why nothing was scanned", () => {
    // Otherwise "there is nothing here" and "you excluded everything" are the same message.
    withTempDir("fairux-ignore-all-", (dir) => {
      fixture(dir, "**\n");
      const result = run(["scan", dir, "--format", "json", "--ignore-config"], dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no scannable files found");
      expect(result.stderr).toContain(".fairuxignore");
      expect(result.stderr).toContain("--no-ignore");
    });
  });

  it("reports a pattern that matched nothing, on stderr", () => {
    withTempDir("fairux-ignore-unused-", (dir) => {
      fixture(dir, "dist/\nnever-here/\n");
      const result = run(["scan", dir, "--format", "json", "--ignore-config"], dir);
      expect(result.stderr).toContain("matched nothing");
      expect(result.stderr).toContain("never-here/");
      // stdout stays machine-readable.
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });

  it("fails clearly on an unsupported pattern rather than matching it approximately", () => {
    withTempDir("fairux-ignore-bad-", (dir) => {
      fixture(dir, "src/[ab].html\n");
      const result = run(["scan", dir, "--format", "json", "--ignore-config"], dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("character classes");
    });
  });
});
