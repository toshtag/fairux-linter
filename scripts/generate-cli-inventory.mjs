#!/usr/bin/env node
/**
 * The public command line, as a checked-in inventory.
 *
 * [Compatibility](../docs/reference/compatibility.md) lists the CLI's flags and exit codes beside
 * the SDK's exports as a public surface, and only one of the two could be checked: a name leaving
 * `sdk-api-inventory.json` fails a build, and a flag leaving `index.ts` looked exactly like editing
 * one. This is the other half — the same two failure modes, separated the same way:
 *
 * - A **removed or renamed** flag, a changed value arity, a lost short alias, a moved default, or a
 *   value dropped from an enumerated set is a break. `--check` exits non-zero and names it.
 * - An **added** command, flag, or value is additive. `--check` reports it and exits zero; the
 *   committed artifact then differs from a fresh run, which CI's worktree-cleanliness gate turns
 *   into a diff somebody reads. An addition should be visible, not fatal.
 *
 * Read from `apps/cli/src/cli-surface.ts` — the declaration `index.ts` builds its program from —
 * and interpreted by **Commander**, the library that interprets it at runtime. Nothing here parses
 * `-f, --format <format>`: a flag string means what the library parsing it says it means, and a
 * second parser written in this file would eventually disagree with the first about a corner of the
 * syntax nobody tested.
 *
 * No build needed, and deliberately so. The surface module imports nothing at runtime, so esbuild
 * bundles it in isolation and this check runs before `pnpm build` in a cold checkout.
 *
 * What is **not** recorded: help text, the wording of a description, and the framework's own
 * `-h, --help` and `-V, --version`. The first two are prose — a contract that pinned them would call
 * a typo fix a breaking change. The last is Commander's, and `apps/cli/test/version.test.ts` holds
 * it by running the CLI rather than by describing it.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ROOT = join(ROOT, "apps/cli");
const SURFACE_ENTRY = "src/cli-surface.ts";
const JSON_ARTIFACT = join(ROOT, "docs/generated/cli-surface-inventory.json");
const MARKDOWN_ARTIFACT = join(ROOT, "docs/generated/cli-surface-inventory.md");

/**
 * What the one dynamic description is given, and what must never reach the artifact.
 *
 * `--risk-index-model` lists the Risk Index models in its help text, and those come from
 * `@fairux/rules` rather than from the command line — a model arriving there is a rule-set change.
 * Descriptions are not recorded, so the value is irrelevant; the assertion below is what makes
 * "irrelevant" a checked claim rather than an assumption.
 */
const PLACEHOLDER = "not-recorded-by-the-cli-inventory";

/** Commander, resolved from the CLI that depends on it rather than from the root. */
const require = createRequire(pathToFileURL(join(CLI_ROOT, "package.json")));

/** The surface module, compiled in memory. */
async function loadSurface() {
  const result = await esbuild({
    absWorkingDir: CLI_ROOT,
    entryPoints: [SURFACE_ENTRY],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced nothing for ${SURFACE_ENTRY}`);
  return import(`data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`);
}

/** `required`, `optional`, or `none` — what the flag does with the word after it. */
function valueArity(option) {
  if (option.required) return "required";
  if (option.optional) return "optional";
  return "none";
}

/**
 * One option, as Commander understands it.
 *
 * `long` is the identity: a short alias may be added or dropped, and the long name is what a script
 * in someone's CI writes. A negated flag (`--no-ignore`) reports its own spelling rather than the
 * attribute it clears, because the spelling is what a user types.
 */
function describeOption(option, spec) {
  return {
    long: option.long,
    ...(option.short ? { short: option.short } : {}),
    value: valueArity(option),
    ...(option.variadic ? { variadic: true } : {}),
    ...(option.negate ? { negates: true } : {}),
    ...(spec?.repeatable ? { repeatable: true } : {}),
    ...(option.defaultValue === undefined ? {} : { default: option.defaultValue }),
    ...(spec?.values ? { values: [...spec.values] } : {}),
  };
}

function describeArgument(argument) {
  return {
    name: argument.name(),
    required: argument.required,
    ...(argument.variadic ? { variadic: true } : {}),
  };
}

async function buildInventory() {
  const surface = await loadSurface();
  const { Command } = require("commander");
  const program = new Command();
  program.name(surface.PROGRAM_NAME);
  // The same wiring `index.ts` runs, with no actions attached: this records the program that ships
  // rather than a second program built to resemble it.
  surface.applyCliSurface(program, {
    riskIndexModelVersions: [PLACEHOLDER],
    defaultRiskIndexModel: PLACEHOLDER,
  });

  const specs = new Map(surface.CLI_COMMANDS.map((spec) => [spec.name, spec]));
  const inventory = {
    schemaVersion: 1,
    note: "Generated from apps/cli/src/cli-surface.ts, as Commander parses it. Not the help text.",
    program: surface.PROGRAM_NAME,
    exitCodes: surface.EXIT_CODES.map((entry) => ({ code: entry.code, meaning: entry.meaning })),
    commands: program.commands.map((command) => {
      const spec = specs.get(command.name());
      const byFlags = new Map((spec?.options ?? []).map((option) => [option.flags, option]));
      return {
        name: command.name(),
        arguments: command.registeredArguments.map(describeArgument),
        optionCount: command.options.length,
        options: command.options.map((option) => describeOption(option, byFlags.get(option.flags))),
      };
    }),
  };

  const serialized = JSON.stringify(inventory);
  if (serialized.includes(PLACEHOLDER)) {
    throw new Error(
      "the CLI inventory recorded a help-text placeholder, so it is recording descriptions after " +
        "all — which would make a reworded sentence look like a surface change",
    );
  }
  return inventory;
}

function renderMarkdown(inventory) {
  const lines = [
    "# CLI public surface inventory",
    "",
    "<!-- Generated by scripts/generate-cli-inventory.mjs. Do not edit by hand. -->",
    "",
    `> ${inventory.note}`,
    "",
    "A command, a flag, a short alias, a value arity, a default, or an accepted value leaving this",
    "file is a breaking change. Arriving is not.",
    "",
    "## Exit codes",
    "",
    "| Code | Meaning |",
    "| --- | --- |",
    ...inventory.exitCodes.map((entry) => `| ${entry.code} | ${entry.meaning} |`),
    "",
  ];
  for (const command of inventory.commands) {
    lines.push(`## \`${inventory.program} ${command.name}\``, "");
    if (command.arguments.length > 0) {
      lines.push(
        `Arguments: ${command.arguments
          .map((entry) => `\`${entry.name}\`${entry.required ? "" : " (optional)"}`)
          .join(", ")}`,
        "",
      );
    }
    lines.push(`${command.optionCount} options.`, "");
    lines.push("| Option | Value | Notes |", "| --- | --- | --- |");
    for (const option of command.options) {
      const notes = [
        option.short ? `alias \`${option.short}\`` : "",
        option.repeatable ? "repeatable" : "",
        option.negates ? "negates" : "",
        option.default === undefined ? "" : `default \`${JSON.stringify(option.default)}\``,
        option.values ? `one of ${option.values.map((v) => `\`${v}\``).join(", ")}` : "",
      ].filter(Boolean);
      lines.push(
        `| \`${option.long}\` | ${option.value === "none" ? "—" : option.value} | ${
          notes.join("; ") || "—"
        } |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Formatted by Biome, so a freshly generated artifact does not fail the repository's own lint. */
function formatted(contents, path) {
  const result = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", path], {
    cwd: ROOT,
    input: contents,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `Biome failed while formatting ${path}`);
  return result.stdout;
}

/** Every option of every command, keyed the way a consumer names it: `scan --format`. */
function optionIndex(inventory) {
  const index = new Map();
  for (const command of inventory.commands) {
    for (const option of command.options) {
      index.set(`${command.name} ${option.long}`, option);
    }
  }
  return index;
}

/**
 * Compare a fresh inventory with the committed one.
 *
 * A removal and a rename are indistinguishable from here, and both break the same script: the flag
 * it passes stops being accepted either way. What each finding names is what a reader needs to judge
 * it — which command, which flag, and what about it moved.
 */
export function diffCliInventories(committed, current) {
  const breaking = [];
  const added = [];

  const currentCommands = new Map(current.commands.map((command) => [command.name, command]));
  for (const before of committed.commands) {
    const after = currentCommands.get(before.name);
    if (!after) {
      breaking.push(`the ${before.name} command is gone`);
      continue;
    }
    for (const [position, argument] of before.arguments.entries()) {
      const now = after.arguments[position];
      if (!now) {
        breaking.push(`${before.name}: the ${argument.name} argument is gone`);
      } else if (
        now.required !== argument.required ||
        Boolean(now.variadic) !== Boolean(argument.variadic)
      ) {
        breaking.push(`${before.name}: the ${argument.name} argument changed shape`);
      }
    }
    if (after.arguments.length > before.arguments.length) {
      added.push(`${before.name}: ${after.arguments.length - before.arguments.length} argument(s)`);
    }
  }

  const currentOptions = optionIndex(current);
  const committedOptions = optionIndex(committed);
  for (const [key, before] of committedOptions) {
    const after = currentOptions.get(key);
    // A command that is gone is reported once, above, rather than once per flag it carried.
    if (!after) {
      if (currentCommands.has(key.split(" ")[0])) breaking.push(`${key} was removed`);
      continue;
    }
    if (before.short && before.short !== after.short) {
      breaking.push(`${key}: the ${before.short} alias is gone`);
    }
    if (before.value !== after.value) {
      breaking.push(`${key}: takes ${after.value} value where it took ${before.value}`);
    }
    if (Boolean(before.repeatable) !== Boolean(after.repeatable)) {
      breaking.push(
        `${key}: repeatable ${before.repeatable ? "no longer collects" : "now collects"}`,
      );
    }
    if (JSON.stringify(before.default) !== JSON.stringify(after.default)) {
      // A default is what a run does when nobody said otherwise, so moving one changes the answer
      // for every invocation that never mentioned the flag.
      breaking.push(
        `${key}: the default moved from ${JSON.stringify(before.default)} to ${JSON.stringify(after.default)}`,
      );
    }
    for (const value of before.values ?? []) {
      if (!(after.values ?? []).includes(value))
        breaking.push(`${key}: no longer accepts "${value}"`);
    }
    for (const value of after.values ?? []) {
      if (!(before.values ?? []).includes(value)) added.push(`${key}: accepts "${value}"`);
    }
    if (!before.short && after.short) added.push(`${key}: alias ${after.short}`);
  }
  for (const key of currentOptions.keys()) {
    if (!committedOptions.has(key)) added.push(key);
  }
  for (const command of current.commands) {
    if (!committed.commands.some((entry) => entry.name === command.name)) {
      added.push(`the ${command.name} command`);
    }
  }

  const committedCodes = new Map(committed.exitCodes.map((entry) => [entry.code, entry.meaning]));
  for (const [code, meaning] of committedCodes) {
    const now = current.exitCodes.find((entry) => entry.code === code);
    if (!now) {
      breaking.push(`exit code ${code} is no longer documented`);
    } else if (now.meaning !== meaning) {
      // Reported rather than refused: nothing here can tell a reworded sentence from a moved
      // meaning, and the committed artifact carries the sentence so the diff shows which it was.
      added.push(`exit code ${code} is described differently — read the diff and decide`);
    }
  }
  for (const entry of current.exitCodes) {
    if (!committedCodes.has(entry.code)) added.push(`exit code ${entry.code}`);
  }

  return { breaking, added };
}

async function main() {
  const inventory = await buildInventory();
  if (!process.argv.includes("--check")) {
    // Rendered and formatted only on the path that writes. `formatted()` starts `pnpm exec biome`,
    // and `--check` — the mode CI runs on every push — used to pay for that subprocess and throw
    // the result away.
    writeFileSync(
      JSON_ARTIFACT,
      formatted(`${JSON.stringify(inventory, null, 2)}\n`, JSON_ARTIFACT),
      "utf8",
    );
    writeFileSync(MARKDOWN_ARTIFACT, renderMarkdown(inventory), "utf8");
    const options = inventory.commands.reduce((sum, command) => sum + command.optionCount, 0);
    process.stdout.write(
      `cli inventory: ${options} options across ${inventory.commands.length} commands\n`,
    );
    return;
  }

  const committed = JSON.parse(readFileSync(JSON_ARTIFACT, "utf8"));
  const { breaking, added } = diffCliInventories(committed, inventory);

  for (const entry of added) process.stdout.write(`cli inventory: added ${entry}\n`);
  if (added.length > 0) {
    process.stdout.write(
      "cli inventory: additions are not breaking. Run `pnpm cli:inventory` so the committed diff shows them.\n",
    );
  }
  if (breaking.length > 0) {
    process.stderr.write(
      `cli inventory: ${breaking.length} breaking change(s) to the published command line:\n` +
        `${breaking.map((entry) => `  - ${entry}`).join("\n")}\n` +
        "A flag leaving the command line breaks every script that passes it. If that is intended, " +
        "it needs a major version and a deprecation first, not a regenerated artifact.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("cli inventory: no breaking change to the published command line\n");
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFilePath) await main();

export { buildInventory };
