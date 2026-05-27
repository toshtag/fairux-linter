import type { RuleContext, UiNode } from "@fairux/core";

/** Pattern list for a dictionary group in the active locale (empty if unknown). */
export function dictGroup(ctx: RuleContext, name: string): readonly RegExp[] {
  return ctx.getDictionary()[name] ?? [];
}

/** Does `text` (normalized internally) match any pattern in the named group? */
export function labelMatches(ctx: RuleContext, text: string, group: string): boolean {
  return ctx.text.hasAny(ctx.text.normalize(text), dictGroup(ctx, group));
}

export function isCheckbox(node: UiNode): boolean {
  return (
    node.tag === "input" &&
    typeof node.attributes.type === "string" &&
    node.attributes.type.toLowerCase() === "checkbox"
  );
}

export function isChecked(node: UiNode): boolean {
  return node.attributes.checked === true;
}

export function isControl(ctx: RuleContext, node: UiNode): boolean {
  return ctx.semantics.isButtonLike(node) || ctx.semantics.isLinkLike(node);
}

const CONTAINER_TAGS = new Set([
  "section",
  "article",
  "form",
  "div",
  "li",
  "main",
  "aside",
  "fieldset",
]);

/**
 * Normalized text of the node's nearest container ancestor (its card/section), falling back
 * to the node itself. This is our heuristic for "text near this control" — conservative on
 * purpose: a broad container means we err toward *not* flagging (fewer false positives).
 */
export function surroundingText(ctx: RuleContext, node: UiNode): string {
  const container = ctx.queries.closest(node, (n) => n.id !== node.id && CONTAINER_TAGS.has(n.tag));
  return (container ?? node).normalizedText;
}
