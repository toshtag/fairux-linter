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
