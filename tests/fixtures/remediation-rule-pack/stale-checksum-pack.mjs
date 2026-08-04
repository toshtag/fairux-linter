/**
 * A RulePack whose safe remediation was computed against different bytes.
 *
 * `fileChecksum` is deliberately not this file's checksum, which is what a real pack produces when
 * the file changes between the scan reading it and the fix being applied. The applier refuses it —
 * and that refusal is a safe fix somebody asked for and did not get, so the run must fail.
 *
 * Separate from `fixable-pack.mjs` because that one's job is the opposite: to succeed.
 */

export const staleChecksumPack = {
  meta: {
    id: "@fixtures/stale-checksum",
    version: "0.0.0-test.0",
    engineApiVersion: "1",
    title: "Stale checksum fixture pack",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "fixtures/stale-fix",
        title: "A safe fix that cannot be applied",
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
        for (const node of doc.all()) {
          if (node.tag !== "input" || node.attributes.checked !== true) continue;
          const startLine = node.source?.startLine;
          const finding = {
            evidence: [{ locator: node.locator, text: "checked", source: node.source }],
            description: "A checkbox is checked by default.",
            whyItMatters: "Pre-checked boxes opt users in without an active choice.",
            recommendation: "Leave consent boxes unchecked.",
          };
          if (file && startLine !== undefined) {
            finding.remediation = {
              id: `fixtures/stale-fix#${startLine}`,
              origin: "rule",
              safety: "safe",
              title: "Remove the checked attribute",
              description: "Removes ` checked` from the input.",
              rationale: "One attribute is removed and no text a user reads changes.",
              file,
              // Not the file's checksum. The applier compares this against what is on disk and
              // refuses, which is the state this fixture exists to produce.
              fileChecksum: "f".repeat(64),
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

export default staleChecksumPack;
