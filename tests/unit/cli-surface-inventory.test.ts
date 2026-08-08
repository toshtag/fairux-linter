import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — the generator is plain JS, like every other one here.
import { diffCliInventories } from "../../scripts/generate-cli-inventory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

interface InventoryOption {
  readonly long: string;
  readonly short?: string;
  readonly value: "none" | "required" | "optional";
  readonly repeatable?: boolean;
  readonly negates?: boolean;
  readonly default?: string | boolean;
  readonly values?: readonly string[];
}
interface InventoryCommand {
  readonly name: string;
  readonly arguments: readonly { readonly name: string; readonly required: boolean }[];
  readonly optionCount: number;
  readonly options: readonly InventoryOption[];
}
interface Inventory {
  readonly program: string;
  readonly exitCodes: readonly { readonly code: number; readonly meaning: string }[];
  readonly commands: readonly InventoryCommand[];
}

interface MutableOption {
  long: string;
  short?: string;
  value: "none" | "required" | "optional";
  repeatable?: boolean;
  negates?: boolean;
  default?: string | boolean;
  values?: string[];
}
interface MutableCommand {
  name: string;
  arguments: { name: string; required: boolean; variadic?: boolean }[];
  optionCount: number;
  options: MutableOption[];
}
interface MutableInventory {
  program: string;
  exitCodes: { code: number; meaning: string }[];
  commands: MutableCommand[];
}

const committed = JSON.parse(
  readFileSync(join(ROOT, "docs/generated/cli-surface-inventory.json"), "utf8"),
) as Inventory;

const clone = (): MutableInventory => JSON.parse(JSON.stringify(committed)) as MutableInventory;

/** The `scan` command of a clone, which every mutation below starts from. */
function scanOf(inventory: MutableInventory): MutableCommand {
  const command = inventory.commands.find((entry) => entry.name === "scan");
  if (!command) throw new Error("the committed inventory has no scan command");
  return command;
}

function optionOf(command: MutableCommand, long: string): MutableOption {
  const option = command.options.find((entry) => entry.long === long);
  if (!option) throw new Error(`scan has no ${long}`);
  return option;
}

interface Diff {
  readonly breaking: string[];
  readonly added: string[];
}
const diff = (before: Inventory | MutableInventory, after: MutableInventory): Diff =>
  diffCliInventories(before, after) as Diff;

/**
 * The comparison is the whole feature, so it is mutation-tested rather than trusted.
 *
 * Every case below is a change somebody could make to `apps/cli/src/cli-surface.ts` in one line, and
 * each one breaks a command line somebody already wrote into their CI configuration. A checker that
 * passes on all of them reads exactly like a checker that works.
 */
describe("what the CLI inventory calls a break", () => {
  it("passes when nothing changed", () => {
    expect(diff(committed, clone())).toEqual({ breaking: [], added: [] });
  });

  it("fails when a flag is removed", () => {
    const after = clone();
    const scan = scanOf(after);
    scan.options = scan.options.filter((option) => option.long !== "--fail-on");
    const result = diff(committed, after);
    expect(result.breaking).toEqual(["scan --fail-on was removed"]);
  });

  it("fails when a flag is renamed, which is a removal with a new name beside it", () => {
    const after = clone();
    optionOf(scanOf(after), "--suppress").long = "--suppressions";
    const result = diff(committed, after);
    expect(result.breaking).toContain("scan --suppress was removed");
    expect(result.added).toContain("scan --suppressions");
  });

  it("fails when a flag stops taking a value, or starts", () => {
    const after = clone();
    optionOf(scanOf(after), "--baseline").value = "none";
    expect(diff(committed, after).breaking[0]).toContain("takes none value where it took required");
  });

  it("fails when a short alias is dropped", () => {
    // `-f` is what a shell history is full of. Dropping it is invisible in the long-name list.
    const after = clone();
    delete optionOf(scanOf(after), "--format").short;
    expect(diff(committed, after).breaking[0]).toContain("the -f alias is gone");
  });

  it("fails when a default moves", () => {
    // Nobody's command line changes and every run's output does, which is the break hardest to see.
    const after = clone();
    optionOf(scanOf(after), "--format").default = "json";
    expect(diff(committed, after).breaking[0]).toContain('the default moved from "markdown" to');
  });

  it("fails when an accepted value is dropped", () => {
    const after = clone();
    const format = optionOf(scanOf(after), "--format");
    format.values = (format.values ?? []).filter((value) => value !== "sarif");
    expect(diff(committed, after).breaking[0]).toContain('no longer accepts "sarif"');
  });

  it("fails when a flag stops collecting repeats", () => {
    // `--rule-pack a --rule-pack b` would silently load one pack instead of two.
    const after = clone();
    delete optionOf(scanOf(after), "--rule-pack").repeatable;
    expect(diff(committed, after).breaking[0]).toContain("no longer collects");
  });

  it("fails when a command disappears, and says so once rather than once per flag", () => {
    const after = clone();
    after.commands = after.commands.filter((command) => command.name !== "explain");
    expect(diff(committed, after).breaking).toEqual(["the explain command is gone"]);
  });

  it("fails when a required argument becomes optional", () => {
    const after = clone();
    const argument = scanOf(after).arguments[0];
    if (argument) argument.required = false;
    expect(diff(committed, after).breaking[0]).toContain("argument changed shape");
  });

  it("fails when an exit code stops being documented", () => {
    const after = clone();
    after.exitCodes = after.exitCodes.filter((entry) => entry.code !== 2);
    expect(diff(committed, after).breaking).toEqual(["exit code 2 is no longer documented"]);
  });

  it("reports a reworded exit code for a reader rather than refusing it", () => {
    // Nothing here can tell a tightened sentence from a moved meaning. The artifact carries the
    // sentence, so the regenerated diff is what a reviewer judges — and CI's worktree gate is what
    // makes them look.
    const after = clone();
    const entry = after.exitCodes[0];
    if (entry) entry.meaning = `${entry.meaning} (reworded)`;
    const result = diff(committed, after);
    expect(result.breaking).toEqual([]);
    expect(result.added[0]).toContain("exit code 0 is described differently");
  });

  it("does not call an addition a break", () => {
    const after = clone();
    scanOf(after).options.push({ long: "--something-new", value: "none" });
    const format = optionOf(scanOf(after), "--format");
    format.values = [...(format.values ?? []), "csv"];
    after.commands.push({ name: "brand-new", arguments: [], optionCount: 0, options: [] });
    const result = diff(committed, after);
    expect(result.breaking).toEqual([]);
    expect(result.added).toContain("scan --something-new");
    expect(result.added).toContain('scan --format: accepts "csv"');
    expect(result.added).toContain("the brand-new command");
  });
});

describe("the committed CLI inventory", () => {
  it("records every command the surface declares, with its option count", () => {
    expect(committed.program).toBe("fairux");
    expect(committed.commands.map((command) => command.name)).toEqual([
      "scan",
      "scan-journey",
      "rules",
      "explain",
    ]);
    for (const command of committed.commands) {
      expect(command.optionCount, command.name).toBe(command.options.length);
    }
  });

  it("records the three exit codes a script branches on", () => {
    expect(committed.exitCodes.map((entry) => entry.code)).toEqual([0, 1, 2]);
    for (const entry of committed.exitCodes) {
      expect(entry.meaning.length, `exit code ${entry.code}`).toBeGreaterThan(40);
    }
  });

  it("records no help text, so a reworded description is not a surface change", () => {
    // The failure this artifact must not become: a contract that fails on a typo fix teaches people
    // to regenerate it without reading it.
    const serialized = JSON.stringify(committed.commands);
    for (const prose of ["output format:", "not sandboxed", "accepted risk"]) {
      expect(serialized, `the inventory should not carry help text (${prose})`).not.toContain(
        prose,
      );
    }
  });
});
