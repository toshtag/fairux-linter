const SAFE_ID = /^[A-Za-z][\w-]*$/;

/**
 * Build a deterministic CSS selector for a node. Prefers `#id` when the element has a safe id,
 * otherwise an `:nth-child` path from the root.
 *
 * Lives in core (not an adapter) so every adapter (HTML, DOM, …) produces identical locators —
 * which is what lets a finding's fingerprint transfer between runtimes. It's a pure string
 * function (no DOM), so it stays browser-safe. CSS is just one `NodeLocator` kind, never the
 * center of the model.
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
