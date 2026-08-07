import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASELINE_SCHEMA_VERSION } from "../src/baseline.js";
import { SUPPRESSIONS_SCHEMA_VERSION } from "../src/suppressions.js";
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

/**
 * When a bad `--suppress` or `--baseline` file stops the run.
 *
 * Both files were read inside `emit()`, which is reached only after the RulePack has been imported
 * as unsandboxed code and after every target has been scanned. So a suppressions file with a missing
 * reason, or a baseline with the wrong `schemaVersion`, cost a full scan *and* a third-party import
 * before anything said so. Reproduced on the previous commit with the marker pack below: the marker
 * file was there afterwards.
 *
 * The order this file pins down is: refuse the invocation, then refuse the filter files, then
 * discover, scan, and import — and write nothing at any point before all of those pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

const PAGE = [
  "<main>",
  '  <label><input type="checkbox" checked> Email me offers</label>',
  "  <p>Only 2 left in stock</p>",
  "</main>",
].join("\n");

/**
 * A RulePack whose import writes a file. Its presence afterwards is the evidence, because the CLI's
 * own trusted-code warning is printed immediately before the import and could in principle be moved.
 */
const MARKER_PACK = [
  'import { writeFileSync } from "node:fs";',
  'import { fileURLToPath } from "node:url";',
  'writeFileSync(fileURLToPath(new URL("./IMPORTED", import.meta.url)), "yes");',
  'export default { id: "marker", rules: [] };',
].join("\n");

function withProject<T>(files: Record<string, string>, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-filter-order-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents, "utf8");
    }
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cli = (args: string[], cwd: string) =>
  spawnSync("node", [cliBin, ...args, "--ignore-config"], {
    encoding: "utf8",
    cwd,
    timeout: CLI_SPAWN_TIMEOUT_MS,
  });

const validBaseline = JSON.stringify({
  schemaVersion: BASELINE_SCHEMA_VERSION,
  note: "Accepted risk, not resolved risk.",
  toolVersion: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
  entries: [],
});

interface BadFile {
  readonly name: string;
  readonly file: string;
  readonly contents: string;
  readonly flag: string;
  readonly says: string;
}

const MALFORMED: readonly BadFile[] = [
  {
    name: "a suppression with no reason",
    file: "s.json",
    contents: JSON.stringify({
      schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
      entries: [{ fingerprint: "aaa" }],
    }),
    flag: "--suppress",
    says: "has no reason",
  },
  {
    name: "a suppression expiring on a day that does not exist",
    file: "s.json",
    contents: JSON.stringify({
      schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
      entries: [{ fingerprint: "aaa", reason: "r", expiresOn: "2026-02-30" }],
    }),
    flag: "--suppress",
    says: "expected a real calendar date",
  },
  {
    name: "a suppression file naming one fingerprint twice",
    file: "s.json",
    contents: JSON.stringify({
      schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
      entries: [
        { fingerprint: "aaa", reason: "one" },
        { fingerprint: "aaa", reason: "two" },
      ],
    }),
    flag: "--suppress",
    says: "twice, at entry 0 and entry 1",
  },
  {
    name: "a suppression file that is not JSON",
    file: "s.json",
    contents: "{ not json",
    flag: "--suppress",
    says: "is not valid JSON",
  },
  {
    name: "a baseline with no note",
    file: "b.json",
    contents: JSON.stringify({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      toolVersion: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      entries: [],
    }),
    flag: "--baseline",
    says: "has no note",
  },
  {
    name: "a baseline whose createdAt is not a date-time",
    file: "b.json",
    contents: JSON.stringify({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      note: "Accepted risk.",
      toolVersion: "test",
      createdAt: "yesterday",
      entries: [],
    }),
    flag: "--baseline",
    says: "expected an ISO 8601 date-time",
  },
  {
    name: "a baseline entry with no ruleId",
    file: "b.json",
    contents: JSON.stringify({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      note: "Accepted risk.",
      toolVersion: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      entries: [{ fingerprint: "aaa" }],
    }),
    flag: "--baseline",
    says: "has no ruleId",
  },
  {
    name: "a baseline naming one fingerprint twice",
    file: "b.json",
    contents: JSON.stringify({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      note: "Accepted risk.",
      toolVersion: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      entries: [
        { fingerprint: "aaa", ruleId: "r" },
        { fingerprint: "aaa", ruleId: "r" },
      ],
    }),
    flag: "--baseline",
    says: "twice, at entry 0 and entry 1",
  },
];

describe("a malformed filter file stops the run before it costs anything", () => {
  for (const bad of MALFORMED) {
    it(`refuses ${bad.name}, before the scan and before the RulePack import`, () => {
      withProject(
        { "page.html": PAGE, "pack.mjs": MARKER_PACK, [bad.file]: bad.contents },
        (dir) => {
          const result = cli(
            [
              "scan",
              "page.html",
              "--rule-pack",
              "./pack.mjs",
              bad.flag,
              bad.file,
              "--risk-index",
              "index.json",
            ],
            dir,
          );
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(bad.says);
          // No report, because nothing was scanned.
          expect(result.stdout.trim()).toBe("");
          // The pack was never imported. This is the half a message cannot prove.
          expect(existsSync(join(dir, "IMPORTED"))).toBe(false);
          expect(result.stderr).not.toContain("as trusted code");
          // And no output file exists under a name a pipeline would then read.
          expect(existsSync(join(dir, "index.json"))).toBe(false);
          expect(readdirSync(dir).sort()).toEqual([bad.file, "pack.mjs", "page.html"].sort());
        },
      );
    });
  }

  it("refuses an incompatible invocation before it even reads the filter files", () => {
    // Both orders matter: a command line that is wrong on its own terms should not report on a
    // file it was never going to use. `--write-baseline` beside `--suppress` is refused as an
    // invocation, so the unreadable suppressions file beside it is never opened.
    withProject({ "page.html": PAGE, "s.json": "{ not json" }, (dir) => {
      const result = cli(
        ["scan", "page.html", "--write-baseline", "out.json", "--suppress", "s.json"],
        dir,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--write-baseline ignores --suppress");
      expect(result.stderr).not.toContain("is not valid JSON");
      expect(existsSync(join(dir, "out.json"))).toBe(false);
    });
  });

  it("still runs, and still filters, when both files are valid", () => {
    // The guard above must not be passing because the flags stopped working.
    withProject(
      {
        "page.html": PAGE,
        "b.json": validBaseline,
        "s.json": JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [{ fingerprint: "not-in-this-page", reason: "kept for the shape" }],
        }),
      },
      (dir) => {
        const result = cli(
          ["scan", "page.html", "--format", "json", "--suppress", "s.json", "--baseline", "b.json"],
          dir,
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).findings.length).toBeGreaterThan(0);
        expect(result.stderr).toContain('suppressions "');
        expect(result.stderr).toContain("accepted risk, not resolved risk");
      },
    );
  });
});
