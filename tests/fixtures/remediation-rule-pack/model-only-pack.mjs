import { removeAttributeEdit } from "../../../packages/sdk/dist/index.js";

/**
 * A RulePack that proposes a fix without reading anything.
 *
 * The counterpart to `fixable-pack.mjs`, which opens the file to find out where ` checked` is. This
 * one imports nothing from `node:` at all — no `fs`, no `crypto` — and builds the same edit from the
 * node it was handed. That is the whole point of the `source-range` capability: a rule that could
 * run in a browser extension can now propose a precise edit, which is the shape a *built-in* rule
 * would have to take.
 *
 * The relative import is a fixture's shortcut to the built SDK. A real external pack depends on
 * `@fairux/sdk` by name.
 */
export const modelOnlyPack = {
  meta: {
    id: "@fixtures/model-only",
    version: "0.0.0-test.0",
    engineApiVersion: "1",
    title: "Remediation fixture pack, with no filesystem",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "fixtures/model-only-checked",
        title: "Pre-checked box, fixed from the model alone",
        category: "consent",
        defaultSeverity: "medium",
        defaultConfidence: "high",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
        maturity: "stable",
        // `source-range` is required, so this rule is skipped — and says it was skipped — anywhere
        // the ranges were not recorded, rather than silently proposing nothing.
        requiredCapabilities: ["structure", "attributes", "source-range"],
        evidenceRequirements: ["attribute-state"],
      },
      evaluate(doc, ctx) {
        const file = doc.metadata?.file;
        const checksum = doc.metadata?.sourceChecksum;
        const findings = [];

        for (const node of doc.all()) {
          if (node.tag !== "input" || node.attributes.checked !== true) continue;
          const finding = {
            evidence: [{ locator: node.locator, text: "checked", source: node.source }],
            description: "A checkbox is checked by default.",
            whyItMatters: "Pre-checked boxes opt users in without an active choice.",
            recommendation: "Leave consent boxes unchecked.",
          };

          const edit = removeAttributeEdit(node, "checked");
          if (file && checksum && edit) {
            finding.remediation = {
              id: `fixtures/model-only-checked#${edit.startLine}`,
              origin: "rule",
              safety: "safe",
              title: "Remove the checked attribute",
              description: "Removes ` checked` from the input.",
              rationale: "One attribute is removed and no text a user reads changes.",
              file,
              fileChecksum: checksum,
              edits: [edit],
            };
          }
          findings.push(ctx.createFinding(finding));
        }
        return findings;
      },
    },
  ],
};

export default modelOnlyPack;
