import type { AccessibilityInfo } from "@fairux/core";

/** Tags whose `alt` contributes an accessible name. */
const ALT_TAGS = new Set(["img", "area", "input"]);

function strAttr(attributes: Record<string, string | true>, name: string): string | undefined {
  const value = attributes[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Best-effort explicit accessible name from cheap, local signals only (`aria-label`, `alt`).
 * `aria-labelledby` needs cross-node id resolution and is filled in a later pass.
 * Deliberately NOT the full WAI-ARIA Accessible Name Computation.
 */
export function explicitName(
  tag: string,
  attributes: Record<string, string | true>,
): AccessibilityInfo | undefined {
  const ariaLabel = strAttr(attributes, "aria-label");
  if (ariaLabel) return { name: ariaLabel, nameSource: "aria-label" };

  if (ALT_TAGS.has(tag)) {
    const alt = strAttr(attributes, "alt");
    const isImageInput = tag !== "input" || strAttr(attributes, "type")?.toLowerCase() === "image";
    if (alt && isImageInput) return { name: alt, nameSource: "alt" };
  }

  return undefined;
}
