import type { Finding, Rule, UiNode } from "@fairux/core";
import { dictGroup, hasClassLike } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

const COUNTDOWN_CLASS_HINTS = ["countdown", "timer", "count-down"];

/** Structural signal: a data-countdown attribute or a countdown/timer-ish class. */
function hasCountdownStructure(node: UiNode): boolean {
  if ("data-countdown" in node.attributes || "data-timer" in node.attributes) return true;
  return hasClassLike(node, COUNTDOWN_CLASS_HINTS);
}

export const countdownTimer: Rule = {
  meta: {
    id: "scarcity/countdown-timer",
    title: "Countdown timer",
    category: "scarcity",
    defaultSeverity: "low",
    defaultConfidence: "low",
    defaultEnabled: true,
    tags: ["scarcity", "urgency", "countdown"],
    version: "1.0.0",
    references: [FTC],
  },
  evaluate(doc, ctx): Finding[] {
    const patterns = dictGroup(ctx, "countdown");
    const findings: Finding[] = [];
    const seen = new Set<string>();

    for (const node of doc.all()) {
      // Match by structure (class/attr) OR by the node's own countdown text.
      const byStructure = hasCountdownStructure(node);
      const match = node.directText
        ? ctx.text.findAny(ctx.text.normalize(node.directText), patterns)
        : null;
      if (!byStructure && !match) continue;

      // De-dup nested hits (a .countdown wrapper + its inner clock text) to one finding per subtree.
      const ancestorSeen = ctx.queries.ancestors(node).some((a) => seen.has(a.id));
      if (ancestorSeen) continue;
      seen.add(node.id);

      const evidenceText = node.directText || match?.[0] || "(countdown)";
      findings.push(
        ctx.createFinding({
          evidence: [{ locator: node.locator, text: evidenceText, source: node.source }],
          description: byStructure
            ? "A countdown timer element was detected (class/attribute)."
            : `Countdown/urgency timer text: "${evidenceText}".`,
          whyItMatters:
            "Countdown timers manufacture time pressure that can push users into rushed decisions.",
          recommendation:
            "Use countdowns only for genuine, verifiable deadlines; avoid artificial or resetting timers.",
          fingerprintText: byStructure ? "countdown-structure" : (match?.[0] ?? evidenceText),
        }),
      );
    }
    return findings;
  },
};
