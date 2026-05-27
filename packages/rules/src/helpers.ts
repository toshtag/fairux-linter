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
