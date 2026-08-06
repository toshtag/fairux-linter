import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * A RulePack that wants the same range as the built-in rule, and wants something different there.
 *
 * `fixable-pack.mjs` proposes the *identical* edit and is coalesced. This one is its negative: same
 * file, same checksum, same coordinates, same expected text — and a different replacement. It keeps
 * the attribute name and drops the value, which is a plausible thing a rule might want and is not
 * what removing the attribute does.
 *
 * Nothing about it may be treated as satisfied by the built-in edit. Two rules disagreeing about one
 * range is a genuine conflict, it is refused, and `--fix-write` fails — which is the boundary the
 * coalescing rule has to stay on the right side of.
 */

const CHECKED = / checked(?=[\s/>])/;

export const conflictingEditPack = {
  meta: {
    id: "@fixtures/conflicting-edit",
    version: "0.0.0-test.0",
    engineApiVersion: "1",
    title: "Conflicting remediation fixture pack",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "fixtures/rename-checked",
        title: "Pre-checked box, with a different fix",
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
          // A pack that cannot read the file still reports the finding.
        }

        for (const node of doc.all()) {
          if (node.tag !== "input" || node.attributes.checked !== true) continue;
          const startLine = node.source?.startLine;
          const finding = {
            evidence: [{ locator: node.locator, text: "checked", source: node.source }],
            description: "A checkbox is checked by default.",
            whyItMatters: "Pre-checked boxes opt users in without an active choice.",
            recommendation: "Record the default rather than applying it.",
          };

          const line = startLine !== undefined ? lines?.[startLine - 1] : undefined;
          const match = line !== undefined ? CHECKED.exec(line) : null;
          if (file && checksum && startLine !== undefined && match?.index !== undefined) {
            const column = match.index + 1;
            finding.remediation = {
              id: `fixtures/rename-checked#${startLine}`,
              origin: "rule",
              safety: "safe",
              title: "Rename the checked attribute",
              description: "Replaces ` checked` with ` data-was-checked`.",
              rationale: "The preselection is recorded rather than removed.",
              file,
              fileChecksum: checksum,
              edits: [
                {
                  startLine,
                  startColumn: column,
                  endLine: startLine,
                  endColumn: column + " checked".length,
                  expected: " checked",
                  // The one field that differs from the built-in edit, and the whole point.
                  replacement: " data-was-checked",
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

export default conflictingEditPack;
