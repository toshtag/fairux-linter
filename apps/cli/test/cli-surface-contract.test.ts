import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_SPAWN_TIMEOUT_MS } from "./cli-process-budget.js";

/**
 * The committed inventory against the program that actually ships.
 *
 * `tests/unit/cli-surface-inventory.test.ts` mutation-tests the comparison, and
 * `docs/generated/cli-surface-inventory.json` is generated from `src/cli-surface.ts` — but both of
 * those would hold just as well if the declaration had stopped being what `index.ts` builds its
 * program from. Then the artifact would describe a command line nobody can run, which is worse than
 * no artifact: a consumer would read a guarantee about a flag that does not exist.
 *
 * So this asks the built CLI. `--help` is Commander's rendering of the options it was given, which
 * makes the flag column the one place the running program lists its own surface, and the exit codes
 * are observed rather than described.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const inventory = JSON.parse(
  readFileSync(resolve(here, "../../../docs/generated/cli-surface-inventory.json"), "utf8"),
) as {
  commands: { name: string; options: { long: string }[] }[];
  exitCodes: { code: number }[];
};

const cli = (args: string[], cwd = here) =>
  spawnSync("node", [cliBin, ...args], { encoding: "utf8", cwd, timeout: CLI_SPAWN_TIMEOUT_MS });

/**
 * The long flags a command's own help lists.
 *
 * An option line starts at column two and its description wraps to column thirty-something, so the
 * first column is the flags Commander was given. Commander's own `-h, --help` is dropped: it is the
 * framework's, not this repository's, and the inventory says so.
 */
function flagsInHelp(command: string): string[] {
  const help = cli([command, "--help"]).stdout;
  const found = new Set<string>();
  for (const line of help.split("\n")) {
    const match = /^ {2}(-\S.*?)(?: {2,}|$)/.exec(line);
    if (!match) continue;
    for (const flag of (match[1] as string).matchAll(/--[a-z][a-z0-9-]*/g)) {
      if (flag[0] !== "--help") found.add(flag[0]);
    }
  }
  return [...found].sort();
}

describe("the inventory describes the CLI that ships", () => {
  it.each(inventory.commands.map((command) => command.name))(
    "lists exactly %s's inventoried flags in its own help",
    (name) => {
      const declared = (inventory.commands.find((command) => command.name === name)?.options ?? [])
        .map((option) => option.long)
        .sort();
      const running = flagsInHelp(name);
      // A parse that found nothing would make the comparison below vacuously true in one direction
      // and impossible in the other; this is what says the help was read at all.
      expect(running.length, `${name} --help listed no flags`).toBeGreaterThan(3);
      expect(running).toEqual(declared);
    },
  );

  it("lists exactly the inventoried commands", () => {
    const help = cli(["--help"]).stdout;
    const listed = [...help.matchAll(/^ {2}([a-z][a-z-]*)/gm)]
      .map((match) => match[1] as string)
      .filter((name) => name !== "help");
    expect(listed.sort()).toEqual(inventory.commands.map((command) => command.name).sort());
  });
});

/**
 * The exit codes, observed.
 *
 * The inventory records what each one means, and prose about an exit code is the part of a CLI
 * contract nothing else checks: no help text mentions it, so a script learns the meaning moved by
 * quietly passing a build it should have failed.
 */
describe("the exit codes the inventory records", () => {
  const PAGE =
    '<html><body><label><input type="checkbox" checked> Email me offers</label></body></html>';

  function withPage<T>(body: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "fairux-exit-"));
    try {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      return body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("records every code these cases produce, and no more", () => {
    expect(inventory.exitCodes.map((entry) => entry.code)).toEqual([0, 1, 2]);
  });

  it("exits 0 for a scan that found something nobody asked it to fail on", () => {
    withPage((dir) => {
      const result = cli(["scan", "page.html", "--ignore-config", "--format", "json"], dir);
      expect(result.status ?? 0).toBe(0);
      expect(JSON.parse(result.stdout).findings.length).toBeGreaterThan(0);
    });
  });

  it("exits 1 when a finding meets --fail-on", () => {
    withPage((dir) => {
      expect(cli(["scan", "page.html", "--ignore-config", "--fail-on", "info"], dir).status).toBe(
        1,
      );
    });
  });

  it("exits 2 for an invocation that is wrong, having done nothing", () => {
    withPage((dir) => {
      const result = cli(["scan", "page.html", "--ignore-config", "--format", "yaml"], dir);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
    });
  });
});
