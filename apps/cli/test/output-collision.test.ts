import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeArtifact } from "../src/artifact-write.js";

/**
 * A scan must not destroy what it was pointed at.
 *
 * `fairux scan page.html --write-baseline page.html` replaced the page with a baseline and exited 0:
 * total, silent loss of a file the user asked to be *read*. The same held for `--risk-index`, and
 * for every other file a run reads — a suppressions list, a baseline, a config, `.fairuxignore`.
 *
 * Every case here is the loss itself, checked by reading the input back afterwards. A test that only
 * asserted the exit code would pass against an implementation that refused *after* writing.
 *
 * The check runs in stages, as each path becomes knowable, and always before any output is opened.
 * It is not a defence against the filesystem changing underneath the run: an output the user named
 * is theirs to replace, and the trusted code this executes could rearrange the tree without going
 * near it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const FIXABLE_PACK = resolve(
  here,
  "../../../tests/fixtures/remediation-rule-pack/fixable-pack.mjs",
);

const PAGE = [
  "<main>",
  '  <label><input type="checkbox" checked> Email me offers</label>',
  "  <p>Only 2 left in stock</p>",
  "</main>",
].join("\n");

function withTempDir<T>(body: (dir: string) => T): T {
  // `realpathSync` is deliberately not applied: on macOS the temp dir is itself a symlink, and
  // leaving it that way means every test here runs through one more layer of indirection than it
  // asks for, which is the layer the check has to see through.
  const dir = mkdtempSync(join(tmpdir(), "fairux-output-safety-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args: string[], cwd: string) {
  return spawnSync("node", [cliBin, ...args, "--ignore-config"], {
    encoding: "utf8",
    cwd,
    timeout: 20000,
  });
}

/** Write a page, run the CLI, and assert the page is byte-identical afterwards. */
function expectRefusedAndIntact(dir: string, args: string[], guarded: string) {
  const before = readFileSync(guarded, "utf8");
  const result = cli(args, dir);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("refusing");
  expect(readFileSync(guarded, "utf8")).toBe(before);
  return result;
}

describe("an output that would overwrite the input", () => {
  it("refuses --write-baseline onto the scanned file", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      const result = expectRefusedAndIntact(
        dir,
        ["scan", "page.html", "--write-baseline", "page.html"],
        file,
      );
      expect(result.stderr).toContain("--write-baseline");
      expect(result.stderr).toContain("the scanned file");
    });
  });

  it("refuses --risk-index onto the scanned file", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      expectRefusedAndIntact(dir, ["scan", "page.html", "--risk-index", "page.html"], file);
    });
  });

  it("sees through a different spelling of the same path", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      // Same file, four ways to say it. A string comparison catches none of these.
      expectRefusedAndIntact(dir, ["scan", "page.html", "--risk-index", "./page.html"], file);
      expectRefusedAndIntact(dir, ["scan", "./page.html", "--risk-index", "page.html"], file);
      expectRefusedAndIntact(dir, ["scan", "page.html", "--risk-index", file], file);
      expectRefusedAndIntact(
        dir,
        ["scan", "page.html", "--risk-index", join(dir, "sub", "..", "page.html")],
        file,
      );
    });
  });

  it("sees through a symlink to the scanned file", (ctx) => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      try {
        symlinkSync(file, join(dir, "alias.html"));
      } catch {
        // Reported as a skip rather than passing silently: a case that did not run must not read as
        // one that did.
        ctx.skip("this system does not allow creating symlinks");
        return;
      }
      expectRefusedAndIntact(dir, ["scan", "page.html", "--risk-index", "alias.html"], file);
      expectRefusedAndIntact(dir, ["scan", "alias.html", "--risk-index", "page.html"], file);
    });
  });

  it.skipIf(process.platform === "win32")(
    "sees through a hard link, which no path comparison can",
    () => {
      withTempDir((dir) => {
        const file = join(dir, "page.html");
        writeFileSync(file, PAGE, "utf8");
        linkSync(file, join(dir, "hard.html"));
        // Two genuinely different paths naming one inode. Only the inode says so.
        expectRefusedAndIntact(dir, ["scan", "page.html", "--risk-index", "hard.html"], file);
      });
    },
  );

  it("refuses when the output is one file of a batch", () => {
    withTempDir((dir) => {
      const a = join(dir, "a.html");
      const b = join(dir, "b.html");
      writeFileSync(a, PAGE, "utf8");
      writeFileSync(b, PAGE, "utf8");
      const result = expectRefusedAndIntact(dir, ["scan", ".", "--risk-index", "b.html"], b);
      expect(result.stderr).toContain("one of the scanned files");
      // The other input is untouched too: the refusal happens before anything is read or written.
      expect(readFileSync(a, "utf8")).toBe(PAGE);
    });
  });

  it("refuses when the output is one file a glob matched", () => {
    withTempDir((dir) => {
      const a = join(dir, "a.html");
      writeFileSync(a, PAGE, "utf8");
      expectRefusedAndIntact(dir, ["scan", "*.html", "--risk-index", "a.html"], a);
    });
  });
});

describe("an output that would overwrite a file the run reads", () => {
  it("refuses to overwrite the suppressions file", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const suppressions = join(dir, "suppress.json");
      writeFileSync(
        suppressions,
        JSON.stringify({ schemaVersion: "1", entries: [] }, null, 2),
        "utf8",
      );
      const result = expectRefusedAndIntact(
        dir,
        ["scan", "page.html", "--suppress", "suppress.json", "--risk-index", "suppress.json"],
        suppressions,
      );
      expect(result.stderr).toContain("--suppress");
    });
  });

  it("refuses to overwrite the baseline it is reading", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const baseline = join(dir, "baseline.json");
      cli(["scan", "page.html", "--write-baseline", "baseline.json"], dir);
      expectRefusedAndIntact(
        dir,
        ["scan", "page.html", "--baseline", "baseline.json", "--risk-index", "baseline.json"],
        baseline,
      );
    });
  });

  it("refuses to overwrite an explicitly named config", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const config = join(dir, "fairux.config.json");
      writeFileSync(config, JSON.stringify({ rules: {} }, null, 2), "utf8");
      const before = readFileSync(config, "utf8");
      const result = spawnSync(
        "node",
        [
          cliBin,
          "scan",
          "page.html",
          "--config",
          "fairux.config.json",
          "--risk-index",
          "fairux.config.json",
        ],
        { encoding: "utf8", cwd: dir, timeout: 20000 },
      );
      expect(result.status).toBe(2);
      expect(readFileSync(config, "utf8")).toBe(before);
    });
  });

  it("refuses to overwrite a config it discovered rather than was given", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const config = join(dir, "fairux.config.json");
      writeFileSync(config, JSON.stringify({ rules: {} }, null, 2), "utf8");
      const before = readFileSync(config, "utf8");
      // No `--ignore-config`, so this is the auto-discovered one — never named on the command line,
      // and just as gone if it is overwritten.
      const result = spawnSync(
        "node",
        [cliBin, "scan", "page.html", "--risk-index", "fairux.config.json"],
        { encoding: "utf8", cwd: dir, timeout: 20000 },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("the discovered config");
      expect(readFileSync(config, "utf8")).toBe(before);
    });
  });

  it("refuses to overwrite a discovered .fairuxignore", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const ignoreFile = join(dir, ".fairuxignore");
      writeFileSync(ignoreFile, "dist/\n", "utf8");
      const before = readFileSync(ignoreFile, "utf8");
      const result = cli(["scan", "page.html", "--risk-index", ".fairuxignore"], dir);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(".fairuxignore");
      expect(readFileSync(ignoreFile, "utf8")).toBe(before);
    });
  });

  it("refuses to overwrite a rule pack it would execute", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      // A copy, never the fixture itself. A test that names a file in this repository as an output
      // destroys that file the moment the guard under test is absent — which is exactly the state
      // this test is run in to prove it fails without the fix.
      const pack = join(dir, "pack.mjs");
      writeFileSync(pack, readFileSync(FIXABLE_PACK, "utf8"), "utf8");
      const before = readFileSync(pack, "utf8");
      const result = spawnSync(
        "node",
        [cliBin, "scan", "page.html", "--ignore-config", "--rule-pack", pack, "--risk-index", pack],
        { encoding: "utf8", cwd: dir, timeout: 20000 },
      );
      expect(result.status).toBe(2);
      // Refused before the pack was loaded, so the warning about executing it never appeared.
      expect(result.stderr).not.toContain("as trusted code");
      expect(readFileSync(pack, "utf8")).toBe(before);
    });
  });
});

describe("what an invalid invocation must not run", () => {
  it("does not load a rule pack before refusing", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      // A pack whose mere import has a side effect. A RulePack is unsandboxed code running with the
      // user's privileges, so an invocation that was never valid must not reach it.
      const pack = join(dir, "marker-pack.mjs");
      writeFileSync(
        pack,
        [
          'import { writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          'writeFileSync(join(import.meta.dirname, "MARKER"), "ran\\n", "utf8");',
          "export const markerPack = {",
          '  meta: { id: "@fixtures/marker", version: "0.0.0-test.0", engineApiVersion: "1",',
          '    title: "Marker", status: "stable" },',
          "  rules: [],",
          "};",
          "export default markerPack;",
        ].join("\n"),
        "utf8",
      );

      const result = cli(
        ["scan", "page.html", "--rule-pack", "./marker-pack.mjs", "--risk-index", "page.html"],
        dir,
      );

      expect(result.status).toBe(2);
      expect(readdirSync(dir)).not.toContain("MARKER");
      // The warning is printed immediately before the import, so its absence is the second witness.
      expect(result.stderr).not.toContain("as trusted code");
    });
  });
});

describe("two outputs that are the same file", () => {
  it("refuses --write-baseline and --risk-index writing to one path", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const result = cli(
        ["scan", "page.html", "--write-baseline", "out.json", "--risk-index", "./out.json"],
        dir,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("refusing");
      // Neither ran, so nothing is left half-written under a name a pipeline would then read.
      expect(existsSync(join(dir, "out.json"))).toBe(false);
    });
  });
});

describe("what is still allowed", () => {
  it("writes a baseline to a path that collides with nothing", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const result = cli(["scan", "page.html", "--write-baseline", "baseline.json"], dir);
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")).entries.length).toBe(2);
    });
  });

  it("writes a Risk Index into a directory that does not exist yet", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      mkdirSync(join(dir, "reports"));
      const result = cli(["scan", "page.html", "--risk-index", "reports/index.json"], dir);
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "reports/index.json"), "utf8")).kind).toBe(
        "risk-index",
      );
    });
  });

  it("replaces an existing output it does not read", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const out = join(dir, "index.json");
      writeFileSync(out, "{}\n", "utf8");
      const result = cli(["scan", "page.html", "--risk-index", "index.json"], dir);
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).kind).toBe("risk-index");
    });
  });

  it("still lets --fix-write edit the file it scanned", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, PAGE, "utf8");
      // The one case where writing to an input is the point, and it must not be caught by this.
      const result = spawnSync(
        "node",
        [
          cliBin,
          "scan",
          "page.html",
          "--ignore-config",
          "--rule-pack",
          FIXABLE_PACK,
          "--fix-write",
        ],
        { encoding: "utf8", cwd: dir, timeout: 20000 },
      );
      expect(result.status).toBe(0);
      expect(readFileSync(file, "utf8")).toContain('<input type="checkbox">');
    });
  });
});

describe("what a failed artifact write says", () => {
  it("does not name a temporary file it never created", () => {
    withTempDir((dir) => {
      // The parent does not exist, so opening the temporary file fails before anything is created.
      const target = join(dir, "missing", "out.json");
      let thrown: Error | undefined;
      try {
        writeArtifact(target, "{}\n");
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown?.message).toMatch(/ENOENT/);
      // Sending a user to look for a file that was never written is a small lie with a real cost:
      // they go looking, find nothing, and trust the next message less.
      expect(thrown?.message).not.toContain("may remain");
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("cleans up the temporary file when the rename fails", () => {
    withTempDir((dir) => {
      // A directory where the target is: the temporary file is created and written, and only the
      // rename fails. That is the one path that can leave something behind.
      const target = join(dir, "occupied");
      mkdirSync(target);

      expect(() => writeArtifact(target, "{}\n")).toThrow(/could not write/);
      // Created, then removed. Nothing left for a user to find, and nothing claimed.
      expect(readdirSync(dir)).toEqual(["occupied"]);
    });
  });
});
