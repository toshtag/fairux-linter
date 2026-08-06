import type { AppliedSuppression, SuppressionDiagnostic } from "@fairux/core";

/**
 * What an inline directive did, on every surface rather than only in JSON.
 *
 * `fairux-disable-next-line` removes a finding inside `scan()`, so it never reaches `findings` at
 * all. The report records it in `suppressed` — with the reason the author had to write — and records
 * a malformed or unused directive in `suppressionDiagnostics`. Both exist because of a stated
 * boundary: a suppression nobody can see is a rule that was silently turned off, and a directive
 * that suppressed nothing while its author believed otherwise is the worse of the two failures.
 *
 * Only the JSON reporter honoured that. Markdown, HTML, and SARIF read `findings` and stopped, so a
 * page with a directive rendered exactly like a page without one — and Markdown and HTML are the
 * surfaces a person actually reads. A reviewer looking at the HTML report of a page whose consent
 * rule had been turned off on line 4 saw a clean report and no way to know.
 *
 * This module is the one description of that section, so the three renderers cannot drift into
 * saying different things about the same report.
 */

/** The heading every surface uses, so a reader who has seen one recognises the others. */
export const SUPPRESSED_HEADING = "Suppressed by an inline directive";
export const DIAGNOSTICS_HEADING = "Directive problems";

/**
 * The sentence that stops the section reading as an accusation or as an all-clear.
 *
 * A directive is a legitimate tool with a required argument. What matters is that it is visible.
 */
export const SUPPRESSED_NOTE =
  "These findings were removed by a comment in the source, with the reason recorded beside each. " +
  "They are not counted above. A suppression is an argument, not a repair — the pattern is still " +
  "in the page.";

export const DIAGNOSTICS_NOTE =
  "A directive that matched nothing, or that could not be read. Each one is a rule somebody meant " +
  "to turn off and did not, or turned off somewhere other than where they thought.";

/**
 * One suppressed finding, as a single line of prose. Ordered as the report recorded them.
 *
 * The fingerprint travels with it. A reader deciding whether the *right* finding was accepted has
 * only the rule and the line otherwise, and two identical inputs on one line are two findings of one
 * rule; it is also what somebody writing a suppressions file has to match on.
 */
export function suppressedLines(suppressed: readonly AppliedSuppression[] | undefined): {
  readonly ruleId: string;
  readonly line: number;
  readonly reason: string;
  readonly fingerprint?: string;
}[] {
  return (suppressed ?? []).map((entry) => ({
    ruleId: entry.ruleId,
    line: entry.line,
    reason: entry.reason,
    ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
  }));
}

/** One directive problem, as a single line of prose. */
export function diagnosticLines(
  diagnostics: readonly SuppressionDiagnostic[] | undefined,
): { readonly line: number; readonly kind: string; readonly message: string }[] {
  return (diagnostics ?? []).map((entry) => ({
    line: entry.line,
    kind: entry.kind,
    message: entry.message,
  }));
}

/** Whether there is anything at all to show, so a surface can skip both headings together. */
export function hasSuppressionRecord(input: {
  readonly suppressed?: readonly AppliedSuppression[];
  readonly suppressionDiagnostics?: readonly SuppressionDiagnostic[];
}): boolean {
  return (input.suppressed?.length ?? 0) > 0 || (input.suppressionDiagnostics?.length ?? 0) > 0;
}
