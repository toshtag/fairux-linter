import type { ExternalFilterEntry, ExternalFilterRecord } from "@fairux/core";

/**
 * What a filter file removed, on every surface rather than only in JSON.
 *
 * `--suppress` and `--baseline` subtract from a report after the scan. The counts a reader sees are
 * therefore what the run *reported*, and nothing on the page said that is not also what it
 * *detected*. Every run wrote the accounting to stderr, which is the one place a stored artifact
 * does not keep: what survives is the HTML somebody attached to a ticket, the Markdown pasted into a
 * pull request, and the SARIF a code-scanning tab ingested.
 *
 * One module describes the section so the surfaces cannot drift into saying different things about
 * the same report — the same reason {@link ./suppression-view.js} exists for inline directives.
 */

export const FILTERS_HEADING = "Removed by a filter file";

export const FILTERS_NOTE =
  "A suppressions or baseline file removed these after the scan. They are not counted above and " +
  "they are not fixed — every one of them is still in the page. The digest identifies the version " +
  "of the file that ran, since the path stays the same as the file grows.";

/** One filter file, flattened into the strings a surface prints. */
export interface ExternalFilterView {
  readonly kind: string;
  readonly file: string;
  readonly digest: string;
  /** `"12 detected, 4 reported"` — the pair that makes the difference readable at a glance. */
  readonly counts: string;
  readonly identity?: string;
  readonly groups: readonly {
    readonly label: string;
    readonly entries: readonly string[];
  }[];
}

function describeEntry(entry: ExternalFilterEntry): string {
  const name = entry.ruleId ?? entry.fingerprint;
  const parts = [entry.count === undefined ? name : `${name} ×${entry.count}`];
  if (entry.reason) parts.push(`— ${entry.reason}`);
  if (entry.expiresOn) parts.push(`(expires ${entry.expiresOn})`);
  // The fingerprint always, even when a ruleId is shown: it is what somebody editing the file has
  // to match on, and a rule id names a class of findings rather than the one that was removed.
  parts.push(`[${entry.fingerprint}]`);
  return parts.join(" ");
}

function group(label: string, entries: readonly ExternalFilterEntry[] | undefined) {
  return entries && entries.length > 0
    ? [{ label, entries: entries.map(describeEntry) }]
    : ([] as { label: string; entries: string[] }[]);
}

export function externalFilterViews(
  records: readonly ExternalFilterRecord[] | undefined,
): ExternalFilterView[] {
  return (records ?? []).map((record) => ({
    kind: record.kind,
    file: record.file,
    digest: record.digest,
    counts: `${record.detected.total} detected, ${record.reported.total} reported`,
    ...(record.identity?.createdAt
      ? { identity: `written ${record.identity.createdAt} by ${record.identity.toolVersion}` }
      : {}),
    groups: [
      ...group("Applied", record.applied),
      // Named apart from unmatched on every surface, because they are different facts: an expired
      // entry stopped applying and its findings are in the report; an unmatched one never applied
      // and is the entry somebody should delete.
      ...group("Expired — no longer suppressing", record.expired),
      ...group("Matched nothing", record.unmatched),
      ...group("No longer present — safe to drop", record.resolved),
    ],
  }));
}

/** Whether there is anything to show, so a surface can skip the whole section. */
export function hasExternalFilters(record: {
  readonly externalFilters?: readonly ExternalFilterRecord[];
}): boolean {
  return (record.externalFilters?.length ?? 0) > 0;
}
