import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  FairUxBatchReport,
  FairUxReport,
  Remediation,
  RemediationApplication,
} from "@fairux/core";
import { applyRemediations } from "@fairux/core";
import {
  assertReplaceableSource,
  commitStaged,
  describeIdentityChange,
  discardStaged,
  type FileIdentity,
  type FileSystemOps,
  nodeFileSystem,
  type StagedFile,
  stageReplacement,
  UnsafeTargetError,
} from "./file-replace.js";

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
  /** What the file was when the plan was made: inode, mode, link count. Absent when unwritable. */
  readonly identity?: FileIdentity;
  /**
   * Why this file cannot be rewritten at all, whatever its remediations say.
   *
   * A symlink, a hard-linked file, a read-only file, something that is not a regular file. Recorded
   * at plan time so a dry run reports the refusal too — a run that said "would apply" and then could
   * not is the disagreement between the two paths this feature is built to avoid.
   */
  readonly unwritable?: string;
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
 *
 * Whether the file *can* be rewritten is decided here too, not at write time. A symlink, a
 * hard-linked file, or a read-only file cannot be replaced without destroying something the user
 * did not ask to change, and a dry run that promised a fix it would then refuse would be the two
 * paths disagreeing.
 */
export function planFixes(
  report: FairUxReport | FairUxBatchReport,
  ops: FileSystemOps = nodeFileSystem,
): FixPlan {
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

    let identity: FileIdentity | undefined;
    let unwritable: string | undefined;
    try {
      identity = assertReplaceableSource(file, ops);
    } catch (error) {
      unwritable = error instanceof UnsafeTargetError ? error.reason : (error as Error).message;
    }

    files.push({
      file,
      application,
      checksum,
      ...(identity ? { identity } : {}),
      ...(unwritable ? { unwritable } : {}),
    });
    refusedCount += application.refused.length;
    // An unwritable file contributes nothing to either count: nothing will be applied to it, and
    // saying otherwise is the overstatement this whole plan exists to avoid.
    if (unwritable) continue;
    appliedCount += application.applied.length;
    if (application.changed) changedFiles.push(file);
  }

  return { files, appliedCount, refusedCount, changedFiles };
}

/** A file that changed between the plan and the write, so the plan no longer describes it. */
export interface StaleFile {
  readonly file: string;
  readonly plannedChecksum: string;
  /** Absent when the file changed in a way that is not about its bytes — replaced, or unreadable. */
  readonly actualChecksum?: string;
  readonly detail: string;
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
 * Is this still the file the plan described?
 *
 * Both halves matter. The checksum catches an edit; the identity catches a file that was replaced,
 * hard-linked, made read-only, or turned into a symlink since — changes that can leave the bytes
 * identical while making the write mean something else entirely.
 */
function findChange(entry: FilePlan, ops: FileSystemOps): StaleFile | undefined {
  const planned = entry.identity;
  let identity: FileIdentity;
  try {
    identity = assertReplaceableSource(entry.file, ops);
  } catch (error) {
    return {
      file: entry.file,
      plannedChecksum: entry.checksum,
      detail: error instanceof UnsafeTargetError ? error.reason : (error as Error).message,
    };
  }
  const identityChange = planned ? describeIdentityChange(planned, identity) : undefined;
  if (identityChange) {
    return { file: entry.file, plannedChecksum: entry.checksum, detail: identityChange };
  }

  let actualChecksum: string;
  try {
    actualChecksum = sha256(readFileSync(entry.file, "utf8"));
  } catch (error) {
    return {
      file: entry.file,
      plannedChecksum: entry.checksum,
      detail: `it could not be read: ${(error as Error).message}`,
    };
  }
  if (actualChecksum !== entry.checksum) {
    return {
      file: entry.file,
      plannedChecksum: entry.checksum,
      actualChecksum,
      detail: "its contents changed",
    };
  }
  return undefined;
}

/**
 * Write a plan out: preflight everything, stage everything, then commit one file at a time.
 *
 * Takes a plan rather than computing one, so the bytes written are the bytes that were described. A
 * function that re-derived them would be a second implementation of the thing the dry run showed.
 *
 * **Preflight** re-checks every file — identity and contents — and one mismatch stops all of them
 * before anything is written. The gap between planning and writing is not empty: an editor saving, a
 * watcher rebuilding, another agent in the same tree. A stale plan written into a changed file
 * destroys work nobody was told about.
 *
 * **Staging** writes each new version beside its target, touching no target. A failure here costs
 * nothing.
 *
 * **Commit** re-checks each file once more, immediately before its rename. That is as close to the
 * write as a lock-free check can be: the window between the final check and the rename cannot be
 * closed without locking or an OS compare-and-swap, and neither is used here. It is small; it is not
 * zero. What it buys is that a file changed *during* the commit — after its own preflight, while
 * earlier files were being renamed — is caught rather than overwritten.
 *
 * Across files this is not a transaction. Once the first rename lands there is no undo, so a later
 * refusal leaves earlier files written. That is reported, never hidden.
 */
export function writeFixes(plan: FixPlan, ops: FileSystemOps = nodeFileSystem): FixWriteOutcome {
  // `unwritable` files were excluded from `changedFiles` at plan time and are excluded here for the
  // same reason: nothing about them can be written, and the plan already says why.
  const changing = plan.files.filter((entry) => entry.application.changed && !entry.unwritable);
  if (changing.length === 0) return { written: [], stale: [], failed: [], ok: true };

  const stale = changing
    .map((entry) => findChange(entry, ops))
    .filter((change) => change !== undefined);
  if (stale.length > 0) return { written: [], stale, failed: [], ok: false };

  const staged: { entry: FilePlan; file: StagedFile }[] = [];
  const failed: FixWriteFailure[] = [];
  for (const entry of changing) {
    try {
      staged.push({
        entry,
        file: stageReplacement(entry.file, entry.application.contents, {
          ops,
          // The mode, owner, and group the file already had. Without this a `0755` script comes back
          // `0644` and stops being executable, and a file gets quietly transferred to whoever ran
          // the tool — changes to the file that nobody asked for.
          ...(entry.identity ? { preserve: entry.identity } : {}),
        }),
      });
    } catch (error) {
      failed.push({ file: entry.file, message: (error as Error).message });
      break;
    }
  }
  if (failed.length > 0) {
    // Nothing was renamed yet, so discarding costs the user nothing and leaves the tree untouched.
    for (const item of staged) discardStaged(item.file, ops);
    return { written: [], stale: [], failed, ok: false };
  }

  const written: string[] = [];
  const lateStale: StaleFile[] = [];
  for (let index = 0; index < staged.length; index += 1) {
    const item = staged[index] as (typeof staged)[number];
    try {
      commitStaged(item.file, {
        ops,
        verify: () => {
          const change = findChange(item.entry, ops);
          if (change) {
            lateStale.push(change);
            throw new Error(change.detail);
          }
        },
      });
      written.push(item.entry.file);
    } catch (error) {
      if (lateStale.length === 0) {
        failed.push({ file: item.entry.file, message: (error as Error).message });
      }
      // Stopped rather than continued: whatever refused this one — a changed file, a full disk — says
      // the tree is not what the plan assumed, and pressing on turns one surprise into several.
      for (const remaining of staged.slice(index + 1)) discardStaged(remaining.file, ops);
      break;
    }
  }
  return { written, stale: lateStale, failed, ok: failed.length === 0 && lateStale.length === 0 };
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
      if (entry.unwritable) {
        // Reported as a refusal rather than as a fix, in the dry run as well as the write. A run
        // that said "applied" here would be claiming an edit to a file it cannot touch — and for a
        // symlink, claiming to have fixed a source that is still exactly as it was.
        lines.push(`fairux: refused ${id} in ${entry.file} — ${entry.unwritable}`);
        continue;
      }
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
  // Files nothing can be written to are counted as refusals, so the totals a reader adds up match
  // the lines above them.
  const unwritableRefusals = plan.files.reduce(
    (total, entry) => total + (entry.unwritable ? entry.application.applied.length : 0),
    0,
  );
  lines.push(
    `fairux: ${appliedNow} ${outcome === undefined ? "applicable" : "applied"}, ` +
      `${plan.refusedCount + unwritableRefusals} refused, across ${plan.files.length} file(s)`,
  );

  for (const entry of outcome?.stale ?? []) {
    lines.push(
      `fairux: "${entry.file}" is not what the plan described — ${entry.detail}, so it was ` +
        `not written`,
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
