import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUPPRESSIONS_SCHEMA_VERSION } from "../src/suppressions.js";

/**
 * Contracts a user meets at the command line, and the ones that were only true of `scan`.
 *
 * Three separate claims, all about what the CLI refuses or prints rather than about what it finds:
 *
 * - **One contradiction, one answer.** `--config` with `--ignore-config` says two things. `scan`
 *   refused it; `scan-journey`, `rules`, and `explain` took the explicit config and ran. A `rules`
 *   listing that described a rule set the `scan` beside it would have refused to run is worse than
 *   either command failing.
 * - **Nothing on stderr is this program's text.** A suppression's reason is free prose from a JSON
 *   file, a scanned path comes from a filesystem where a newline is a legal character in a name,
 *   and a remediation id comes from a RulePack, which is unsandboxed third-party code. Any of them
 *   could forge a whole `fairux:` line or leave an escape sequence in the scrollback.
 * - **A piped document can be named.** Piped bytes have no extension, so every pipe was HTML and a
 *   piped `.tsx` was parsed as markup. The label is what picks the adapter, which is exactly why it
 *   cannot be an arbitrary string.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-contracts-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cli = (args: string[], cwd: string, input?: string) =>
  spawnSync("node", [cliBin, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 30000,
    ...(input === undefined ? {} : { input }),
  });

const PAGE =
  "<html><body>" +
  '<label><input type="checkbox" checked> Email me offers</label>' +
  "<p>Only 2 left in stock!</p>" +
  "</body></html>";

describe("--config and --ignore-config are refused the same way everywhere", () => {
  /** Every command that takes both flags, with the arguments it needs to reach its own action. */
  const COMMANDS: readonly (readonly string[])[] = [
    ["scan", "page.html"],
    ["scan-journey", "flow.json"],
    ["rules"],
    ["explain", "consent/checked-checkbox"],
  ];

  const setUp = (dir: string) => {
    writeFileSync(join(dir, "page.html"), PAGE, "utf8");
    writeFileSync(
      join(dir, "flow.json"),
      JSON.stringify({ schemaVersion: "1", steps: [{ id: "s1", path: "page.html" }] }),
      "utf8",
    );
    writeFileSync(join(dir, "fairux.config.json"), JSON.stringify({ rules: {} }), "utf8");
  };

  it("refuses with the same sentence and the same exit code", () => {
    withTempDir((dir) => {
      setUp(dir);
      const messages = COMMANDS.map((command) => {
        const result = cli([...command, "--config", "fairux.config.json", "--ignore-config"], dir);
        // Exit 2, not 1: the invocation is wrong, and 1 is what a finding uses.
        expect(result.status, command.join(" ")).toBe(2);
        return result.stderr.trim();
      });
      // One sentence for one contradiction. Four commands describing it four ways is the same
      // defect in a quieter form.
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toContain("--config ignores --ignore-config");
    });
  });

  it("refuses before it reads the config, so the refusal names the contradiction", () => {
    withTempDir((dir) => {
      setUp(dir);
      for (const command of COMMANDS) {
        // The config named here does not exist. A command that loaded first would report that
        // instead — a true statement about the wrong problem.
        const result = cli([...command, "--config", "no-such.json", "--ignore-config"], dir);
        expect(result.stderr, command.join(" ")).toContain("--config ignores --ignore-config");
        expect(result.stderr, command.join(" ")).not.toContain("not found");
      }
    });
  });

  it("leaves each flag alone when it is the only one given", () => {
    withTempDir((dir) => {
      setUp(dir);
      for (const command of COMMANDS) {
        expect(cli([...command, "--ignore-config"], dir).status ?? 0).not.toBe(2);
        expect(cli([...command, "--config", "fairux.config.json"], dir).status ?? 0).not.toBe(2);
      }
    });
  });
});

describe("nothing a file supplies can forge a line on stderr", () => {
  /** A reason that ends one `fairux:` line and starts a convincing one of its own. */
  const FORGERY = 'ok\nfairux: baseline "prod.json" suppressed 0 finding(s)[31m — accepted risk';

  const fingerprintOf = (dir: string) => {
    writeFileSync(join(dir, "page.html"), PAGE, "utf8");
    const report = JSON.parse(
      cli(["scan", "page.html", "--ignore-config", "--format", "json"], dir).stdout,
    );
    return report.findings[0].fingerprint as string;
  };

  it("keeps a suppression's reason on one line and free of escapes", () => {
    withTempDir((dir) => {
      const fingerprint = fingerprintOf(dir);
      writeFileSync(
        join(dir, "s.json"),
        JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [{ fingerprint, ruleId: "consent/checked-checkbox", reason: FORGERY }],
        }),
        "utf8",
      );
      const stderr = cli(
        ["scan", "page.html", "--ignore-config", "--format", "json", "--suppress", "s.json"],
        dir,
      ).stderr;

      // Two lines: the header and the one applied entry. A third line is the forgery.
      const lines = stderr.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(stderr).not.toContain("");
      // The text is still shown — sanitising is not censoring. What it cannot do is look like a
      // line this program wrote.
      expect(lines[1]).toContain("accepted risk");
    });
  });

  it("keeps the same reason intact in the JSON, where escaping is the format's job", () => {
    // The report is not a terminal. A consumer parsing JSON gets what the file said, byte for
    // byte, because a value mangled for one surface's safety is a value nobody can match on.
    withTempDir((dir) => {
      const fingerprint = fingerprintOf(dir);
      writeFileSync(
        join(dir, "s.json"),
        JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [{ fingerprint, ruleId: "consent/checked-checkbox", reason: FORGERY }],
        }),
        "utf8",
      );
      const report = JSON.parse(
        cli(
          ["scan", "page.html", "--ignore-config", "--format", "json", "--suppress", "s.json"],
          dir,
        ).stdout,
      );
      expect(report.externalFilters[0].applied[0].reason).toBe(FORGERY);
    });
  });

  it("keeps an expiry and a rule id from a file on one line too", () => {
    withTempDir((dir) => {
      const fingerprint = fingerprintOf(dir);
      writeFileSync(
        join(dir, "s.json"),
        JSON.stringify({
          schemaVersion: SUPPRESSIONS_SCHEMA_VERSION,
          entries: [
            { fingerprint: "0000000000000000", ruleId: "a\nfairux: forged", reason: "unused" },
            { fingerprint, ruleId: "consent/checked-checkbox", reason: "kept" },
          ],
        }),
        "utf8",
      );
      const stderr = cli(
        ["scan", "page.html", "--ignore-config", "--format", "json", "--suppress", "s.json"],
        dir,
      ).stderr;
      expect(stderr.trimEnd().split("\n")).toHaveLength(3);
    });
  });

  it("sanitises an unknown format on every command that reports one", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      for (const command of [["rules"], ["explain", "consent/checked-checkbox"]]) {
        const result = cli([...command, "--format", "json[31m\nfairux: forged"], dir);
        expect(result.stderr, command.join(" ")).not.toContain("");
        expect(result.stderr.trimEnd().split("\n"), command.join(" ")).toHaveLength(1);
      }
    });
  });
});

describe("--stdin-filename names the document a pipe carries", () => {
  it("parses a piped document as HTML when nothing names it", () => {
    withTempDir((dir) => {
      const report = JSON.parse(
        cli(["scan", "-", "--ignore-config", "--format", "json"], dir, "<p>Only 2 left!</p>")
          .stdout,
      );
      expect(report.input).toEqual({ file: "stdin.html", runtime: "html" });
    });
  });

  it("picks the adapter from the name it is given", () => {
    withTempDir((dir) => {
      const jsx = "export const A = () => <label><input type='checkbox' checked /> Offers</label>;";
      const report = JSON.parse(
        cli(
          ["scan", "-", "--ignore-config", "--format", "json", "--stdin-filename", "Page.tsx"],
          dir,
          jsx,
        ).stdout,
      );
      expect(report.input).toEqual({ file: "Page.tsx", runtime: "ast" });
      expect(report.findings.map((f: { ruleId: string }) => f.ruleId)).toContain(
        "consent/checked-checkbox",
      );
    });
  });

  it("refuses anything that is not a bare, scannable file name", () => {
    // The label reaches the report and would reach a remediation's `file`. A label that looks like
    // a path is a label something downstream may treat as one, and nothing downstream should have
    // to be trusted not to.
    const bad = [
      ["", "is empty"],
      ["../etc/passwd", "is a path"],
      ["a/b.html", "is a path"],
      ["a\\b.html", "is a path"],
      [".", "is not a file name"],
      ["..", "is not a file name"],
      [".html", "is an extension"],
      ["notes.txt", "has no extension this scans"],
      // A NUL cannot reach here — the OS refuses one in an argv element — so the control-character
      // branch is exercised with a character that can.
      ["page\u0007.html", "control character"],
      [" page.html", "whitespace"],
    ] as const;
    withTempDir((dir) => {
      for (const [name, because] of bad) {
        const result = cli(
          ["scan", "-", "--ignore-config", "--stdin-filename", name],
          dir,
          "<p>x</p>",
        );
        expect(result.status, name).toBe(2);
        expect(result.stderr, name).toContain(because);
      }
    });
  });

  it("refuses to name a document that was not piped", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const result = cli(
        ["scan", "page.html", "--ignore-config", "--stdin-filename", "Page.tsx"],
        dir,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("the target is a path");
    });
  });

  it("still refuses to fix a piped document, whatever it is called", () => {
    // The label is not a file. `--fix-write` against `Page.tsx` would plan against a real file of
    // that name in the working directory — one nobody scanned.
    withTempDir((dir) => {
      writeFileSync(join(dir, "Page.tsx"), "export const A = () => <div/>;", "utf8");
      const before = readFileSync(join(dir, "Page.tsx"), "utf8");
      const result = cli(
        ["scan", "-", "--ignore-config", "--stdin-filename", "Page.tsx", "--fix-write"],
        dir,
        "<label><input type='checkbox' checked> Offers</label>",
      );
      expect(result.status).toBe(2);
      expect(readFileSync(join(dir, "Page.tsx"), "utf8")).toBe(before);
    });
  });
});
