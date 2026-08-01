import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type {
  FairUxBatchReport,
  FairUxReport,
  Remediation,
  RemediationApplication,
} from "@fairux/core";
import { applyRemediations } from "@fairux/core";

/**
 * `--fix-dry-run` and `--fix-write`.
 *
 * The two share every decision. `plan()` produces what would happen; writing is one branch at the
 * end that takes the result and puts it on disk. Two code paths that agree in tests and diverge in
 * practice is how this feature goes wrong everywhere it goes wrong.
 *
 * The roadmap calls the applying flag "safe-only `--write`". It is `--fix-write` here, because
 * `--write` beside the existing `--write-baseline` would be two flags whose names promise the same
 * thing and do entirely different ones.
 */

export function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

export interface FilePlan {
  readonly file: string;
  readonly application: RemediationApplication;
}

export interface FixPlan {
  readonly files: readonly FilePlan[];
  readonly appliedCount: number;
  readonly refusedCount: number;
  /** Files whose contents would change. Empty when there is nothing to do. */
  readonly changedFiles: readonly string[];
}

function remediationsByFile(
  report: FairUxReport | FairUxBatchReport,
): ReadonlyMap<string, Remediation[]> {
  const findings =
    report.kind === "batch" ? report.reports.flatMap((entry) => entry.findings) : report.findings;
  const byFile = new Map<string, Remediation[]>();
  for (const finding of findings) {
    const remediation = finding.remediation;
    if (!remediation) continue;
    const list = byFile.get(remediation.file);
    if (list) list.push(remediation);
    else byFile.set(remediation.file, [remediation]);
  }
  return byFile;
}

/**
 * What applying would do, without doing it.
 *
 * Each file is read once and hashed here, because the checksum has to describe the bytes on disk
 * right now rather than the ones the scan saw — that gap is exactly what the refusal exists for.
 */
export function planFixes(report: FairUxReport | FairUxBatchReport): FixPlan {
  const files: FilePlan[] = [];
  let appliedCount = 0;
  let refusedCount = 0;
  const changedFiles: string[] = [];

  // Sorted, so the plan a user reads and the order files are written in do not depend on which rule
  // happened to run first.
  for (const [file, remediations] of [...remediationsByFile(report)].sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const contents = readFileSync(file, "utf8");
    const application = applyRemediations(contents, remediations, {
      actualChecksum: sha256(contents),
    });
    files.push({ file, application });
    appliedCount += application.applied.length;
    refusedCount += application.refused.length;
    if (application.changed) changedFiles.push(file);
  }

  return { files, appliedCount, refusedCount, changedFiles };
}

/**
 * Write a plan out.
 *
 * Takes a plan rather than computing one, so the bytes written are the bytes that were described. A
 * function that re-derived them would be a second implementation of the thing the dry run showed.
 */
export function writeFixes(plan: FixPlan): void {
  for (const entry of plan.files) {
    if (!entry.application.changed) continue;
    writeFileSync(entry.file, entry.application.contents, "utf8");
  }
}

/** What a reader is told, identically for a dry run and a write. */
export function describeFixPlan(plan: FixPlan, written: boolean): string {
  if (plan.files.length === 0) {
    return (
      "fairux: no findings carry a remediation, so there is nothing to apply\n" +
      "fairux: no built-in rule proposes one yet — this reports on remediations from rule packs\n"
    );
  }

  const lines: string[] = [];
  for (const entry of plan.files) {
    for (const id of entry.application.applied) {
      lines.push(`fairux: ${written ? "applied" : "would apply"} ${id} in ${entry.file}`);
    }
    for (const refusal of entry.application.refused) {
      // Every refusal, always. A skipped fix nobody was told about is the same silence as a fix that
      // landed on the wrong bytes.
      lines.push(`fairux: refused ${refusal.remediationId} in ${entry.file} — ${refusal.message}`);
    }
  }
  lines.push(
    `fairux: ${plan.appliedCount} ${written ? "applied" : "applicable"}, ${plan.refusedCount} refused, ` +
      `across ${plan.files.length} file(s)`,
  );
  if (!written && plan.changedFiles.length > 0) {
    lines.push("fairux: nothing was written — pass --fix-write to apply these");
  }
  return `${lines.join("\n")}\n`;
}
