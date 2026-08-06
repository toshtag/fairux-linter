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

/**
 * What separates one shadow root's selector from the next in a `css` locator.
 *
 * A selector cannot cross a shadow boundary. `document.querySelector` does not descend into a
 * shadow root, and neither does any selector syntax a browser still implements — so a node the DOM
 * adapter found *inside* an open shadow root has no single selector that reaches it. Written as one
 * anyway, its `:nth-child` path was resolved against the light DOM and matched whatever happened to
 * sit at those indexes: a different element, highlighted as if it were the finding.
 *
 * A locator crossing a boundary is therefore a **sequence**: each segment is resolved against the
 * previous match's `shadowRoot`, starting at the document. `>>>` is the historical shadow-piercing
 * combinator and reads as one; more usefully, it is **not** valid CSS in any engine, so a consumer
 * that splits on nothing and passes the whole string to `querySelector` gets a thrown
 * `SyntaxError` — the one failure mode that cannot be mistaken for a match.
 *
 * It cannot collide with a generated selector: {@link buildSelector} emits tag names, `:nth-child`,
 * `#id` restricted to {@link SAFE_ID}, and ` > `, none of which contain `>>>`.
 */
export const SHADOW_LOCATOR_SEPARATOR = " >>> ";

/**
 * Split a `css` locator into the selectors to resolve, one per document or shadow root.
 *
 * A locator with no shadow hop returns a single segment, so a caller written for the flat form and
 * one written for this agree on every ordinary document.
 */
export function splitCssLocator(value: string): string[] {
  return value.split(SHADOW_LOCATOR_SEPARATOR);
}

/** Join per-root selectors into one `css` locator value. The inverse of {@link splitCssLocator}. */
export function joinCssLocator(segments: readonly string[]): string {
  return segments.join(SHADOW_LOCATOR_SEPARATOR);
}
