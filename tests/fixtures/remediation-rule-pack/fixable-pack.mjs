import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * A RulePack that proposes fixes, for exercising `--fix-dry-run` and `--fix-write`.
 *
 * It lives in fixtures rather than in `@fairux/rules` for two reasons. Attaching a remediation to a
 * built-in rule is a rule change and needs a maintainer review — and, more interestingly, a built-in
 * rule *could not* build this one: the normalized model carries a node's start position and not the
 * position of an attribute inside it, so a precise edit range is not derivable from what a rule sees.
 *
 * An external pack can read the file, because an external pack is trusted, unsandboxed Node code —
 * which the RulePack documentation says in as many words. That is what this fixture does, and it is
 * the shape a real fixing pack takes today.
 */

const CHECKED = / checked(?=[\s/>])/;

export const fixablePack = {
  meta: {
    id: "@fixtures/fixable",
    version: "0.0.0-test.0",
    engineApiVersion: "1",
    title: "Remediation fixture pack",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "fixtures/pre-checked-box",
        title: "Pre-checked box, with a fix",
        category: "consent",
        defaultSeverity: "medium",
        defaultConfidence: "high",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "attributes", "source-location"],
        evidenceRequirements: ["attribute-state"],
      },
      evaluate(doc, ctx) {
        const file = doc.metadata?.file;
        const findings = [];
        let lines;
        let checksum;
        try {
          const source = file ? readFileSync(file, "utf8") : undefined;
          if (source !== undefined) {
            lines = source.split("\n");
            checksum = createHash("sha256").update(source, "utf8").digest("hex");
          }
        } catch {
          // A pack that cannot read the file still reports the finding. Silence would be worse than
          // a finding without a fix.
        }

        for (const node of doc.all()) {
          if (node.tag !== "input" || node.attributes.checked !== true) continue;
          const startLine = node.source?.startLine;
          const finding = {
            evidence: [{ locator: node.locator, text: "checked", source: node.source }],
            description: "A checkbox is checked by default.",
            whyItMatters: "Pre-checked boxes opt users in without an active choice.",
            recommendation: "Leave consent boxes unchecked.",
          };

          const line = startLine !== undefined ? lines?.[startLine - 1] : undefined;
          const match = line !== undefined ? CHECKED.exec(line) : null;
          // Only when every part of the edit is known. A range built from a guess is the exact
          // failure `expected` exists to catch, and a rule producing one would be relying on the
          // applier to notice.
          if (file && checksum && startLine !== undefined && match?.index !== undefined) {
            const column = match.index + 1;
            finding.remediation = {
              id: `fixtures/pre-checked-box#${startLine}`,
              origin: "rule",
              safety: "safe",
              title: "Remove the checked attribute",
              description: "Removes ` checked` from the input.",
              rationale: "One attribute is removed and no text a user reads changes.",
              file,
              fileChecksum: checksum,
              edits: [
                {
                  startLine,
                  startColumn: column,
                  endLine: startLine,
                  endColumn: column + " checked".length,
                  expected: " checked",
                  replacement: "",
                },
              ],
            };
          }
          findings.push(ctx.createFinding(finding));
        }
        return findings;
      },
    },
    {
      meta: {
        id: "fixtures/scarcity-copy",
        title: "Scarcity copy, with a rewrite that needs review",
        category: "scarcity",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "text", "source-location"],
        evidenceRequirements: ["text-match"],
      },
      evaluate(doc, ctx) {
        const file = doc.metadata?.file;
        const findings = [];
        for (const node of doc.all()) {
          if (!node.directText.includes("Only 2 left")) continue;
          const startLine = node.source?.startLine;
          const finding = {
            evidence: [{ locator: node.locator, text: node.directText, source: node.source }],
            description: "Scarcity phrasing.",
            whyItMatters: "Unverified scarcity can pressure users.",
            recommendation: "Show scarcity only when it is backed by real data.",
          };
          if (file && startLine !== undefined) {
            // `review-required`, and the rationale says why: a machine should not decide what a user
            // reads. This is the classification doing its job rather than a hedge.
            finding.remediation = {
              id: `fixtures/scarcity-copy#${startLine}`,
              origin: "rule",
              safety: "review-required",
              title: "Replace the scarcity claim",
              description: "Rewrites the sentence to state stock without pressure.",
              rationale: "It changes copy a user reads, which is a decision for a person to make.",
              file,
              fileChecksum: "0".repeat(64),
              edits: [
                {
                  startLine,
                  startColumn: 1,
                  endLine: startLine,
                  endColumn: 1,
                  expected: "",
                  replacement: "",
                },
              ],
            };
          }
          findings.push(ctx.createFinding(finding));
        }
        return findings;
      },
    },
  ],
};

export default fixablePack;
