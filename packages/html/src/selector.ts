const SAFE_ID = /^[A-Za-z][\w-]*$/;

/**
 * Build a deterministic CSS selector for a node. Prefers `#id` when the element has a
 * safe id, otherwise an `:nth-child` path from the root. This is the only place CSS
 * selectors are produced — they are evidence/locator detail, never part of the core model.
 */
export function buildSelector(
  parentSelector: string | undefined,
  tag: string,
  nthChild: number,
  htmlId: string | undefined,
): string {
  if (htmlId && SAFE_ID.test(htmlId)) return `#${htmlId}`;
  if (parentSelector === undefined) return tag;
  return `${parentSelector} > ${tag}:nth-child(${nthChild})`;
}
