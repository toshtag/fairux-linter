import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  FairUxBatchReport,
  FairUxReport,
  Remediation,
  RemediationApplication,
} from "@fairux/core";
import { applyRemediations } from "@fairux/core";
import { writeFileAtomic } from "./atomic-write.js";

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
  /**
   * The file's SHA-256 when the plan was made.
   *
   * Kept so the write can prove the bytes it is about to replace are still the ones the plan
   * described. The remediation carries a checksum of its own, but that one is the scan's; between
   * the scan and the plan a file may legitimately have changed and been refused for it, and this is
   * the later of the two observations.
   */
  readonly checksum: string;
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
    const checksum = sha256(contents);
    const application = applyRemediations(contents, remediations, {
      actualChecksum: checksum,
    });
    files.push({ file, application, checksum });
    appliedCount += application.applied.length;
    refusedCount += application.refused.length;
    if (application.changed) changedFiles.push(file);
  }

  return { files, appliedCount, refusedCount, changedFiles };
}

/** A file that changed between the plan and the write, so the plan no longer describes it. */
export interface StaleFile {
  readonly file: string;
  readonly plannedChecksum: string;
  readonly actualChecksum: string;
}

/** A file the commit phase could not replace. The filesystem said no; the reason is carried. */
export interface FixWriteFailure {
  readonly file: string;
  readonly message: string;
}

export interface FixWriteOutcome {
  /** Files actually replaced, in the order they were written. */
  readonly written: readonly string[];
  readonly stale: readonly StaleFile[];
  readonly failed: readonly FixWriteFailure[];
  /** True only when every file the plan would change was written. */
  readonly ok: boolean;
}

/**
 * Write a plan out.
 *
 * Takes a plan rather than computing one, so the bytes written are the bytes that were described. A
 * function that re-derived them would be a second implementation of the thing the dry run showed.
 *
 * Every file is re-read and re-hashed first, and one mismatch stops all of them. The gap between
 * planning and writing is small but not empty — an editor saving, a watcher rebuilding, another
 * agent working in the same tree — and a stale plan written into a changed file destroys work
 * nobody was told about. `--fix-write` is documented as safe-only, and a fix that lands on bytes it
 * was not computed against is not safe whatever the remediation was classified as.
 *
 * All-or-nothing across files is the preflight, not the commit: once the first rename lands there is
 * no undo, so a later failure leaves earlier files written. That is reported rather than hidden,
 * because the alternative — claiming a transaction this does not implement — is what would make a
 * user trust it wrongly.
 */
export function writeFixes(plan: FixPlan): FixWriteOutcome {
  const changing = plan.files.filter((entry) => entry.application.changed);
  if (changing.length === 0) return { written: [], stale: [], failed: [], ok: true };

  const stale: StaleFile[] = [];
  for (const entry of changing) {
    let actualChecksum: string;
    try {
      actualChecksum = sha256(readFileSync(entry.file, "utf8"));
    } catch (error) {
      // Unreadable now, readable at plan time: deleted, renamed, or permissions changed. Treated as
      // stale rather than as a write failure, because it is the same question — are these still the
      // bytes the plan described — and the answer is no.
      return {
        written: [],
        stale,
        failed: [{ file: entry.file, message: (error as Error).message }],
        ok: false,
      };
    }
    if (actualChecksum !== entry.checksum) {
      stale.push({ file: entry.file, plannedChecksum: entry.checksum, actualChecksum });
    }
  }
  if (stale.length > 0) return { written: [], stale, failed: [], ok: false };

  const written: string[] = [];
  const failed: FixWriteFailure[] = [];
  for (const entry of changing) {
    try {
      writeFileAtomic(entry.file, entry.application.contents);
      written.push(entry.file);
    } catch (error) {
      failed.push({ file: entry.file, message: (error as Error).message });
      // Stopped rather than continued: whatever refused that write — a full disk, a read-only tree —
      // is likely to refuse the next one, and a run that keeps going turns one failure into many
      // half-applied files.
      break;
    }
  }
  return { written, stale, failed, ok: failed.length === 0 };
}

/**
 * What a reader is told, identically for a dry run and a write.
 *
 * `outcome` is absent for a dry run and present for a write, so the verb per file is what happened
 * to that file rather than what was asked for: a run stopped by a stale plan must not report a fix
 * as applied, and a run that wrote three files before the fourth failed must not report all four the
 * same way.
 */
export function describeFixPlan(plan: FixPlan, outcome?: FixWriteOutcome): string {
  if (plan.files.length === 0) {
    return (
      "fairux: no findings carry a remediation, so there is nothing to apply\n" +
      "fairux: no built-in rule proposes one yet — this reports on remediations from rule packs\n"
    );
  }

  const wrote = (file: string): boolean => outcome?.written.includes(file) === true;
  const lines: string[] = [];
  for (const entry of plan.files) {
    for (const id of entry.application.applied) {
      const verb =
        outcome === undefined ? "would apply" : wrote(entry.file) ? "applied" : "did not";
      lines.push(`fairux: ${verb} ${id} in ${entry.file}`);
    }
    for (const refusal of entry.application.refused) {
      // Every refusal, always. A skipped fix nobody was told about is the same silence as a fix that
      // landed on the wrong bytes.
      lines.push(`fairux: refused ${refusal.remediationId} in ${entry.file} — ${refusal.message}`);
    }
  }

  // The count of what happened, not of what was possible: a plan with two applicable fixes that
  // wrote neither says "0 applied", because the number a reader acts on is the one on disk.
  const appliedNow =
    outcome === undefined
      ? plan.appliedCount
      : plan.files
          .filter((entry) => wrote(entry.file))
          .reduce((total, entry) => total + entry.application.applied.length, 0);
  lines.push(
    `fairux: ${appliedNow} ${outcome === undefined ? "applicable" : "applied"}, ` +
      `${plan.refusedCount} refused, across ${plan.files.length} file(s)`,
  );

  for (const entry of outcome?.stale ?? []) {
    lines.push(
      `fairux: "${entry.file}" changed after the plan was made — nothing was written, because ` +
        `these edits were computed against different bytes`,
    );
  }
  if ((outcome?.stale.length ?? 0) > 0) {
    lines.push("fairux: re-run the scan to plan against the file as it now stands");
  }
  for (const failure of outcome?.failed ?? []) {
    lines.push(`fairux: could not write "${failure.file}" — ${failure.message}`);
  }
  if (outcome && !outcome.ok && outcome.written.length > 0) {
    // Said plainly, because this is the one state that is neither "applied" nor "unchanged": some
    // files carry the fix and some do not, and only the run knows which.
    lines.push(
      `fairux: ${outcome.written.length} file(s) were written before this stopped — the tree is ` +
        `partly fixed`,
    );
  }
  if (outcome === undefined && plan.changedFiles.length > 0) {
    lines.push("fairux: nothing was written — pass --fix-write to apply these");
  }
  return `${lines.join("\n")}\n`;
}
