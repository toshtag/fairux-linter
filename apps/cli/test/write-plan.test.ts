import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What state of the filesystem a run is allowed to write on the strength of.
 *
 * The collision check answers "are these the same file?" once, before the scan. The writer then
 * looked at the path again at write time and took *that* as its starting point — so anything that
 * moved in between was written over as though it had always been the output. A scan takes long
 * enough for that to happen: the rule packs it runs are ordinary Node code, and so is an executable
 * config.
 *
 * These drive the change from inside the scan itself, through a rule pack, which is exactly the
 * window a real editor, watcher, or build step would use. No sleeps.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

const PAGE = [
  "<main>",
  '  <label><input type="checkbox" checked> Email me offers</label>',
  "  <p>Only 2 left in stock</p>",
  "</main>",
].join("\n");

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-write-plan-"));
  try {
    return body(dir);
  } finally {
    try {
      for (const entry of readdirSync(dir)) chmodSync(join(dir, entry), 0o644);
    } catch {
      // Best effort.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A rule pack that runs `body` the first time a document is evaluated.
 *
 * The scan is the window this is about, and a rule pack is what runs inside it.
 */
function packThatRuns(dir: string, body: string): string {
  const path = join(dir, "meddling-pack.mjs");
  writeFileSync(
    path,
    [
      'import { renameSync, writeFileSync, rmSync } from "node:fs";',
      "let done = false;",
      "export const meddlingPack = {",
      '  meta: { id: "@fixtures/meddling", version: "0.0.0-test.0", engineApiVersion: "1",',
      '    title: "Meddling", status: "stable" },',
      "  rules: [{",
      '    meta: { id: "meddling/noop", title: "No-op", category: "consent",',
      '      defaultSeverity: "info", defaultConfidence: "low", defaultEnabled: true, tags: [],',
      '      version: "1.0.0", maturity: "stable", requiredCapabilities: ["structure"],',
      '      evidenceRequirements: ["text-match"] },',
      "    evaluate() {",
      "      if (!done) { done = true;",
      `        ${body}`,
      "      }",
      "      return [];",
      "    },",
      "  }],",
      "};",
      "export default meddlingPack;",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function cli(args: string[], cwd: string) {
  return spawnSync("node", [cliBin, ...args, "--ignore-config"], {
    encoding: "utf8",
    cwd,
    timeout: 20000,
  });
}

describe("the state a write is allowed on the strength of", () => {
  it("refuses when the scanned file is moved onto the output path mid-scan", () => {
    withTempDir((dir) => {
      const page = join(dir, "page.html");
      writeFileSync(page, PAGE, "utf8");
      // The collision check passes: `page.html` and `out.json` are different files. Then the input
      // becomes the output, and the write lands on the user's page.
      const pack = packThatRuns(
        dir,
        `renameSync(${JSON.stringify(page)}, ${JSON.stringify(join(dir, "out.json"))});`,
      );

      const result = cli(
        ["scan", "page.html", "--rule-pack", pack, "--risk-index", "out.json"],
        dir,
      );

      expect(result.status).not.toBe(0);
      // The page's contents, under whatever name it now has.
      expect(readFileSync(join(dir, "out.json"), "utf8")).toBe(PAGE);
    });
  });

  it("refuses when something else creates the output mid-scan", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const other = join(dir, "out.json");
      const pack = packThatRuns(
        dir,
        `writeFileSync(${JSON.stringify(other)}, "SOMEBODY ELSE'S FILE\\n", "utf8");`,
      );

      const result = cli(
        ["scan", "page.html", "--rule-pack", pack, "--risk-index", "out.json"],
        dir,
      );

      expect(result.status).not.toBe(0);
      // The output did not exist when the run started. That does not make it ours now.
      expect(readFileSync(other, "utf8")).toBe("SOMEBODY ELSE'S FILE\n");
    });
  });

  it("refuses when the existing output is changed mid-scan", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const out = join(dir, "out.json");
      writeFileSync(out, "{}\n", "utf8");
      const pack = packThatRuns(
        dir,
        `writeFileSync(${JSON.stringify(out)}, "EDITED BY SOMEBODY\\n", "utf8");`,
      );

      const result = cli(
        ["scan", "page.html", "--rule-pack", pack, "--risk-index", "out.json"],
        dir,
      );

      expect(result.status).not.toBe(0);
      expect(readFileSync(out, "utf8")).toBe("EDITED BY SOMEBODY\n");
    });
  });

  it("refuses when the existing output is deleted mid-scan", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const out = join(dir, "out.json");
      writeFileSync(out, "{}\n", "utf8");
      const pack = packThatRuns(dir, `rmSync(${JSON.stringify(out)});`);

      const result = cli(
        ["scan", "page.html", "--rule-pack", pack, "--risk-index", "out.json"],
        dir,
      );

      expect(result.status).not.toBe(0);
      expect(existsSync(out)).toBe(false);
    });
  });

  it.skipIf(process.platform === "win32")("refuses to replace a read-only output", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const out = join(dir, "out.json");
      writeFileSync(out, "{}\n", "utf8");
      // A rename over a read-only file succeeds where opening it for writing would not. The
      // filesystem's own protection must not be routed around by the way this writes.
      chmodSync(out, 0o444);

      const result = cli(["scan", "page.html", "--risk-index", "out.json"], dir);

      expect(result.status).not.toBe(0);
      expect(readFileSync(out, "utf8")).toBe("{}\n");
    });
  });

  it("still writes when nothing moved", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const result = cli(["scan", "page.html", "--risk-index", "out.json"], dir);
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).kind).toBe("risk-index");
    });
  });
});

describe("what an invalid invocation must not execute", () => {
  it("does not run an executable config before refusing", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      // An executable config is trusted, unsandboxed code — the CLI says so before running it. An
      // invocation that was never valid must not reach it, exactly as it must not reach a pack.
      const config = join(dir, "fairux.config.mjs");
      writeFileSync(
        config,
        [
          'import { writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          'writeFileSync(join(import.meta.dirname, "CONFIG-MARKER"), "ran\\n", "utf8");',
          "export default { rules: {} };",
        ].join("\n"),
        "utf8",
      );

      const result = spawnSync(
        "node",
        [cliBin, "scan", "page.html", "--config", "fairux.config.mjs", "--risk-index", "page.html"],
        { encoding: "utf8", cwd: dir, timeout: 20000 },
      );

      expect(result.status).toBe(2);
      expect(readdirSync(dir)).not.toContain("CONFIG-MARKER");
      expect(result.stderr).not.toContain("as trusted code");
      expect(readFileSync(join(dir, "page.html"), "utf8")).toBe(PAGE);
    });
  });

  it("still runs a valid invocation's config exactly once", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const config = join(dir, "fairux.config.mjs");
      writeFileSync(
        config,
        [
          'import { appendFileSync } from "node:fs";',
          'import { join } from "node:path";',
          'appendFileSync(join(import.meta.dirname, "CONFIG-RUNS"), "x", "utf8");',
          "export default { rules: {} };",
        ].join("\n"),
        "utf8",
      );

      const result = spawnSync(
        "node",
        [cliBin, "scan", "page.html", "--config", "fairux.config.mjs"],
        { encoding: "utf8", cwd: dir, timeout: 20000 },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(join(dir, "CONFIG-RUNS"), "utf8")).toBe("x");
    });
  });
});
