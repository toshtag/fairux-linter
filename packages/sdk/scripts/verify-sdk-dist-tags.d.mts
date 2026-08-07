/** Read the pre-publish snapshot, fail-closed on every unreadable form. */
export declare function readDistTagSnapshot(
  filePath: string,
): { distTags: Record<string, unknown> } | { error: string };
