import { readFileSync } from "node:fs";
import type {
  FairUxBatchReport,
  FairUxReport,
  Remediation,
  RemediationApplication,
} from "@fairux/core";
import { applyRemediations } from "@fairux/core";
import { sanitizeForTerminal } from "./load-config.js";
import {
  rewriteSourceInPlace,
  SourceChangedError,
  SourcePathChangedError,
  sha256,
} from "./source-write.js";

/**
 * `--fix-dry-run` and `--fix-write`.
 *
 * The two share every decision. `planFixes()` produces what would happen; writing is one branch at
 * the end that takes the result and puts it on disk. Two code paths that agree in tests and diverge
 * in practice is how this feature goes wrong everywhere it goes wrong.
 *
 * The roadmap calls the applying flag "safe-only `--write`". It is `--fix-write` here, because
 * `--write` beside the existing `--write-baseline` would be two flags whose names promise the same
 * thing and do entirely different ones.
 *
 * What a fix protects against is a stale plan: the file changing between the scan that produced the
 * remediation and the write that applies it — an editor saving, a watcher rebuilding, a rebase. It
 * does not defend against a rule pack that wants to damage the tree, because a rule pack is
 * unsandboxed code running with the user's privileges and can do that directly.
 */

export { sha256 };

/**
 * Decode so that re-encoding gives back exactly these bytes, or refuse.
 *
 * Two ways that fails. `Buffer.toString("utf8")` replaces every invalid sequence with U+FFFD, so
 * writing the result back rewrites bytes all over the file. And a decoder strips a leading BOM by
 * default, so a file that had one comes back three bytes shorter — a change nowhere near the
 * finding, in a file the fix was supposed to touch in one place.
 *
 * `ignoreBOM: true` means "treat it as an ordinary character" rather than "ignore it". The round
 * trip is then checked rather than assumed.
 */
function decodeExactly(bytes: Buffer): string | undefined {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : undefined;
}

export interface FilePlan {
  readonly file: string;
  readonly application: RemediationApplication;
  /**
   * The file's SHA-256 when the plan was made, over its bytes.
   *
   * Not over the decoded text: every invalid UTF-8 sequence decodes to the same replacement
   * character, so two files that differ in their bytes would hash the same.
   */
  readonly checksum: string;
  /** Why nothing can be written to this file, whatever its remediations say. */
  readonly unwritable?: string;
}

export interface FixPlan {
  readonly files: readonly FilePlan[];
  readonly appliedCount: number;
  /**
   * Remediations an earlier one had already satisfied with the same edit, character for character.
   *
   * Counted separately from both of the others. It is not an application — no second edit was made —
   * and it is not a refusal: what the remediation asked for is in the file, so it must not fail the
   * run. Two rules reaching the same conclusion about one attribute is the ordinary case here.
   */
  readonly coalescedCount: number;
  readonly refusedCount: number;
  /** Files whose contents would change. Empty when there is nothing to do. */
  readonly changedFiles: readonly string[];
  /**
   * Safe remediations that were asked for and cannot be applied.
   *
   * Not the same as `refusedCount`. A `review-required` remediation was never going to be applied
   * and its refusal is the feature working. A safe one that could not land is a fix somebody asked
   * for and did not get, and a run that reports success after that tells a script the tree was fixed
   * when it was not.
   */
  readonly blockedCount: number;
}

/** Refusals that mean "this was never going to apply", as opposed to "a safe fix did not happen". */
const NEVER_APPLIED: ReadonlySet<string> = new Set(["review-required", "ai-origin"]);

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
  let coalescedCount = 0;
  let refusedCount = 0;
  let blockedCount = 0;
  const changedFiles: string[] = [];

  // Sorted, so the plan a user reads and the order files are written in do not depend on which rule
  // happened to run first.
  for (const [file, remediations] of [...remediationsByFile(report)].sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const bytes = readFileSync(file);
    const checksum = sha256(bytes);
    const decoded = decodeExactly(bytes);
    // The scan reads the same file leniently, so a finding can exist here. What cannot happen is
    // writing it back: the round trip through a string would rewrite bytes the fix never touched.
    const contents = decoded ?? bytes.toString("utf8");
    const application = applyRemediations(contents, remediations, { actualChecksum: checksum });
    const unwritable =
      decoded === undefined
        ? "does not survive a UTF-8 round trip, so applying an edit would rewrite bytes outside it"
        : undefined;

    files.push({ file, application, checksum, ...(unwritable ? { unwritable } : {}) });
    coalescedCount += application.coalesced.length;
    refusedCount += application.refused.length;
    blockedCount += application.refused.filter(
      (refusal) => !NEVER_APPLIED.has(refusal.code),
    ).length;
    if (unwritable) {
      // Nothing will be applied to it, and every safe remediation it had is a fix that did not
      // happen.
      blockedCount += application.applied.length;
      continue;
    }
    appliedCount += application.applied.length;
    if (application.changed) changedFiles.push(file);
  }

  return { files, appliedCount, coalescedCount, refusedCount, changedFiles, blockedCount };
}

/** A file that changed between the plan and the write, so the plan no longer describes it. */
export interface StaleFile {
  readonly file: string;
  /**
   * Which of the two ways the file stopped being the one the plan described.
   *
   * `checksum-changed` is an edit to the same file. `path-replaced` is the path naming a different
   * file altogether — what an editor's atomic save does — and there is no "actual checksum" for it,
   * because the file that was checked is not the file at that path any more.
   */
  readonly reason: "checksum-changed" | "path-replaced";
  readonly plannedChecksum: string;
  readonly actualChecksum?: string;
}

/** A file the write phase could not replace. The filesystem said no; the reason is carried. */
export interface FixWriteFailure {
  readonly file: string;
  readonly message: string;
}

export interface FixWriteOutcome {
  /** Files actually rewritten, in the order they were written. */
  readonly written: readonly string[];
  readonly stale: readonly StaleFile[];
  readonly failed: readonly FixWriteFailure[];
  /**
   * True only when every safe fix that was asked for landed.
   *
   * A run that was asked to write and wrote nothing it was asked to did not succeed, whether the
   * obstacle was a changed file, a permission, or a file whose bytes will not round-trip.
   */
  readonly ok: boolean;
}

/**
 * Write a plan out, one file at a time.
 *
 * Each file is checked immediately before it is written and skipped if it changed. That is the
 * protection: a plan is only valid for the bytes it was computed against.
 *
 * This is not a transaction. The first file is on disk before the second is looked at, so a refusal
 * partway leaves the tree partly fixed — reported, never hidden. Staging every file first would not
 * change that, because the renames would still happen one at a time; it would only add up to
 * `MAX_BATCH_FILES` temporary files to the user's tree for the same guarantee.
 */
export function writeFixes(plan: FixPlan): FixWriteOutcome {
  const changing = plan.files.filter((entry) => entry.application.changed && !entry.unwritable);
  const written: string[] = [];
  const stale: StaleFile[] = [];
  const failed: FixWriteFailure[] = [];

  for (const entry of changing) {
    try {
      rewriteSourceInPlace(entry.file, entry.application.contents, entry.checksum);
      written.push(entry.file);
    } catch (error) {
      if (error instanceof SourceChangedError) {
        stale.push({
          file: entry.file,
          reason: "checksum-changed",
          plannedChecksum: error.expected,
          actualChecksum: error.actual,
        });
      } else if (error instanceof SourcePathChangedError) {
        stale.push({ file: entry.file, reason: "path-replaced", plannedChecksum: entry.checksum });
      } else {
        failed.push({ file: entry.file, message: (error as Error).message });
      }
      // Stopped rather than continued: whatever refused this one says the tree is not what the plan
      // assumed, and pressing on turns one surprise into several.
      break;
    }
  }

  return {
    written,
    stale,
    failed,
    ok:
      stale.length === 0 &&
      failed.length === 0 &&
      plan.blockedCount === 0 &&
      written.length === changing.length,
  };
}

/**
 * What a reader is told, identically for a dry run and a write.
 *
 * `outcome` is absent for a dry run and present for a write, so the verb per file is what happened
 * to that file rather than what was asked for: a run stopped by a stale file must not report a fix
 * as applied, and a run that wrote three files before the fourth failed must not report all four the
 * same way.
 */
export function describeFixPlan(plan: FixPlan, outcome?: FixWriteOutcome): string {
  if (plan.files.length === 0) {
    return (
      "fairux: no findings carry a remediation, so there is nothing to apply\n" +
      "fairux: most findings have no mechanical fix — a remediation is proposed only where the " +
      "edit is exact, and a rule pack may add more\n"
    );
  }

  const wrote = (file: string): boolean => outcome?.written.includes(file) === true;
  // Every value below reaches a terminal, and none of them is this program's. A path comes from the
  // filesystem, where a newline is a legal character in a name; a remediation id and its refusal
  // message come from a RulePack, which is third-party executable code by design. Either can forge
  // a `fairux:` line of its own or leave an escape sequence in the scrollback.
  const safe = sanitizeForTerminal;
  const lines: string[] = [];
  for (const entry of plan.files) {
    if (entry.unwritable) {
      // Once per file, whether or not any remediation reached the point of being applicable: a file
      // this cannot write is a fact about the file, and a reader who saw only per-remediation
      // refusals would be told the rule's reason instead of the real one.
      lines.push(`fairux: cannot write ${safe(entry.file)} — it ${entry.unwritable}`);
    }
    for (const id of entry.application.applied) {
      if (entry.unwritable) {
        lines.push(`fairux: refused ${safe(id)} in ${safe(entry.file)} — ${entry.unwritable}`);
        continue;
      }
      const verb =
        outcome === undefined ? "would apply" : wrote(entry.file) ? "applied" : "did not";
      lines.push(`fairux: ${verb} ${safe(id)} in ${safe(entry.file)}`);
    }
    for (const merge of entry.application.coalesced) {
      // Named, not counted, and never silent. Two rules asked for the same edit; a reader is told
      // which one made it, so "one edit for two remediations" is legible rather than a discrepancy
      // between the plan and the diff.
      if (entry.unwritable) {
        lines.push(
          `fairux: refused ${safe(merge.remediationId)} in ${safe(entry.file)} — ${entry.unwritable}`,
        );
        continue;
      }
      const verb =
        outcome === undefined ? "would coalesce" : wrote(entry.file) ? "coalesced" : "did not";
      lines.push(
        `fairux: ${verb} ${safe(merge.remediationId)} in ${safe(entry.file)} — ${safe(merge.satisfiedBy)} ` +
          `makes the identical edit`,
      );
    }
    for (const refusal of entry.application.refused) {
      // Every refusal, always. A skipped fix nobody was told about is the same silence as a fix that
      // landed on the wrong bytes.
      lines.push(
        `fairux: refused ${safe(refusal.remediationId)} in ${safe(entry.file)} — ${safe(refusal.message)}`,
      );
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
  const unwritableRefusals = plan.files.reduce(
    (total, entry) =>
      total +
      (entry.unwritable
        ? entry.application.applied.length + entry.application.coalesced.length
        : 0),
    0,
  );
  const coalescedNow =
    outcome === undefined
      ? plan.coalescedCount
      : plan.files
          .filter((entry) => wrote(entry.file))
          .reduce((total, entry) => total + entry.application.coalesced.length, 0);
  // Its own number, only when there is one. A count of three that silently meant "two applied and
  // one that was already the same edit" would be the discrepancy this reporting exists to remove.
  const coalescedPart = coalescedNow > 0 ? `${coalescedNow} coalesced, ` : "";
  lines.push(
    `fairux: ${appliedNow} ${outcome === undefined ? "applicable" : "applied"}, ` +
      `${coalescedPart}${plan.refusedCount + unwritableRefusals} refused, ` +
      `across ${plan.files.length} file(s)`,
  );

  for (const entry of outcome?.stale ?? []) {
    lines.push(
      entry.reason === "path-replaced"
        ? `fairux: "${safe(entry.file)}" stopped naming the file that was opened for this fix — ` +
            `something replaced it, and nothing at that path was written`
        : `fairux: "${safe(entry.file)}" changed since it was scanned, so it was not written — re-run ` +
            `the scan to plan against the file as it now stands`,
    );
  }
  for (const failure of outcome?.failed ?? []) {
    lines.push(`fairux: could not write "${safe(failure.file)}" — ${safe(failure.message)}`);
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
