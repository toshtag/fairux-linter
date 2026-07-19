import { fairuxBuiltinRulePack } from "@fairux/sdk";
import { createHtmlScanner } from "@fairux/sdk/html";
import sdkManifest from "@fairux/sdk/package.json" with { type: "json" };
import { purchaseGuardRulePack } from "../sdk-custom-rule-pack/purchase-guard-pack.mjs";

const ruleOverrides = { "consent/checked-checkbox": false };
const scanner = createHtmlScanner({
  includeExperimental: true,
  rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
  ruleOverrides,
  now: () => new Date("2026-01-01T00:00:00Z"),
});
ruleOverrides["consent/checked-checkbox"] = true;

const first = scanner.scan(
  '<main><label><input type="checkbox" checked> Send marketing offers</label><button>Buy now</button></main>',
  { file: "first.html" },
);
const second = scanner.scan("<main><button>Buy now</button></main>", { file: "second.html" });

if (first.rulePacks?.length !== 2 || second.rulePacks?.length !== 2) {
  throw new Error("expected provenance for two rule packs");
}
if (JSON.stringify(first.rulePacks) !== JSON.stringify(second.rulePacks)) {
  throw new Error("expected reusable scanner provenance to stay stable");
}
if (first.findings.some((finding) => finding.ruleId === "consent/checked-checkbox")) {
  throw new Error("expected ruleOverrides false to stay snapshotted");
}
if (
  !second.findings.some((finding) => finding.ruleId === "@purchase-guard/missing-return-policy")
) {
  throw new Error("expected custom Purchase Guard finding");
}
if (first.toolVersion !== sdkManifest.version || second.toolVersion !== sdkManifest.version) {
  throw new Error(
    `expected report.toolVersion ${sdkManifest.version}, got ${first.toolVersion}/${second.toolVersion}`,
  );
}

console.log(
  JSON.stringify({
    ok: true,
    findings: first.summary.total + second.summary.total,
    toolVersion: first.toolVersion,
    reusable: true,
  }),
);
