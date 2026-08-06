#!/usr/bin/env node
/**
 * `pnpm verify:full` — run the whole offline gate and report every step that failed.
 *
 * The list, and the reasoning behind it, is in `verify-full-contract.mjs`. This file only runs it:
 * the decisions are there so a test can read them without starting a build, which is the same split
 * the other contract modules in this directory use.
 *
 * It keeps going after a failure. A contributor running this before a completion pull request wants
 * the list of what is wrong, not the first thing that is — and every step is a build or a read-only
 * check, so a later one is not made meaningless by an earlier one failing.
 */

import { runCommand } from "./run-command.mjs";
import { VERIFY_FULL_STEPS } from "./verify-full-contract.mjs";

const started = Date.now();
const failures = [];

for (const [index, step] of VERIFY_FULL_STEPS.entries()) {
  process.stdout.write(
    `\n[${index + 1}/${VERIFY_FULL_STEPS.length}] pnpm ${step.script} — ${step.why}\n`,
  );
  const stepStarted = Date.now();
  try {
    // `expectStatus: 0` is `runCommand`'s default, so a non-zero exit throws with the output
    // attached rather than being reported as a success with a stderr nobody reads.
    const { stdout, stderr } = runCommand("pnpm", [step.script], { timeout: 900_000 });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.stdout.write(
      `  ✓ ${step.script} (${Math.round((Date.now() - stepStarted) / 1000)}s)\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`  ✗ ${step.script}\n`);
    failures.push(step.script);
  }
}

const seconds = Math.round((Date.now() - started) / 1000);
if (failures.length > 0) {
  process.stderr.write(
    `\nverify:full failed after ${seconds}s — ${failures.length} of ` +
      `${VERIFY_FULL_STEPS.length} step(s):\n` +
      failures.map((script) => `  pnpm ${script}\n`).join(""),
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `\n✓ verify:full passed — ${VERIFY_FULL_STEPS.length} steps in ${seconds}s\n`,
  );
}
