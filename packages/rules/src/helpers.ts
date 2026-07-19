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
 * The node's nearest container ancestor (its card/section/form/...), falling back to the
 * document root when there is no wrapping container. Rules use this to evaluate "is X near
 * this control" *locally* instead of across the whole page — which catches disclosures/options
 * that live in a far-away footer while still degrading to whole-page behavior for flat markup.
 */
export function nearestContainer(ctx: RuleContext, node: UiNode): UiNode {
  return (
    ctx.queries.closest(node, (n) => n.id !== node.id && CONTAINER_TAGS.has(n.tag)) ?? ctx.doc.root
  );
}

/** Normalized text of the node's nearest container — the heuristic "text near this node". */
export function surroundingText(ctx: RuleContext, node: UiNode): string {
  return nearestContainer(ctx, node).normalizedText;
}

/** Self + descendants of a node, for "is there a control like X within this container". */
export function within(ctx: RuleContext, container: UiNode): UiNode[] {
  return [container, ...ctx.queries.descendants(container)];
}

// ── Class / inline-style helpers (used by the heuristic, mostly experimental, rules) ─────────

export function classTokens(node: UiNode): string[] {
  const cls = node.attributes.class;
  return typeof cls === "string" ? cls.toLowerCase().split(/\s+/).filter(Boolean) : [];
}

export function hasClassLike(node: UiNode, needles: readonly string[]): boolean {
  const tokens = classTokens(node);
  return tokens.some((token) => needles.some((needle) => token.includes(needle)));
}

export function styleMap(node: UiNode): Record<string, string> {
  const style = node.attributes.style;
  if (typeof style !== "string") return {};
  const out: Record<string, string> = {};
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const key = declaration.slice(0, colon).trim().toLowerCase();
    if (key)
      out[key] = declaration
        .slice(colon + 1)
        .trim()
        .toLowerCase();
  }
  return out;
}

export function parsePx(value: string | undefined): number | undefined {
  const match = value?.match(/(\d+(?:\.\d+)?)/);
  return match?.[1] ? Number(match[1]) : undefined;
}

// ── Modal / close-control detection (shared by the obstruction rules) ────────────────────────

const MODAL_CLASS_HINTS = ["modal", "popup", "overlay", "lightbox", "dialog"];
const CLOSE_SYMBOLS = new Set(["×", "✕", "✖", "x"]);

export function isModalLike(node: UiNode): boolean {
  return (
    node.role === "dialog" ||
    node.role === "alertdialog" ||
    node.tag === "dialog" ||
    hasClassLike(node, MODAL_CLASS_HINTS)
  );
}

export function isCloseAction(ctx: RuleContext, node: UiNode): boolean {
  if (!isControl(ctx, node)) return false;
  const label = ctx.semantics.getControlLabel(node);
  if (labelMatches(ctx, label, "close")) return true;
  if (hasClassLike(node, ["close", "dismiss"])) return true;
  return CLOSE_SYMBOLS.has(label.trim().toLowerCase());
}
