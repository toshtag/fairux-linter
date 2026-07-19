#!/usr/bin/env node
import { writeFileSync } from "node:fs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const version = arg("--version") ?? process.env.SDK_VERSION;
const out = arg("--out");
if (!version) {
  console.error("Usage: release-notes.mjs --version <version> [--out <file>]");
  process.exit(2);
}

const notes = `\`@fairux/sdk\` beta release.

- Status: beta, intended for reviewed external RulePack authoring and deterministic scans.
- Node support: \`^22.18.0 || >=24.11.0\`.
- Entry points: \`@fairux/sdk\`, \`@fairux/sdk/html\`, and \`@fairux/sdk/dom\`.
- Includes custom RulePack composition, external taxonomy categories, external page contexts, and rule overrides.
- Third-party RulePacks are trusted executable JavaScript, not sandboxed plugins.
- Known limitations: no scoring, baselines, suppressions, fixes, \`--write\`, registry-installed external product proof, or AI review.
- Migration: see \`docs/migrations/rule-pack-taxonomy-beta.1.md\`.

Install after publication:

\`\`\`bash
npm install @fairux/sdk@${version}
\`\`\`
`;

if (out) writeFileSync(out, notes, "utf8");
else process.stdout.write(notes);
