import { fairuxBuiltinRulePack } from "@fairux/sdk";
import { createDomScanner, ScannerPolicyError } from "@fairux/sdk/dom";
import { purchaseGuardRulePack } from "../sdk-custom-rule-pack/valid/purchase-guard-pack.mjs";

const scanner = createDomScanner({
  includeExperimental: true,
  rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
  now: () => new Date("2026-01-01T00:00:00Z"),
});

export function scanCurrentDocument(): {
  findings: number;
  reused: boolean;
  toolVersion: string;
  contextFinding: boolean;
  taxonomyCategories: number;
  taxonomyPageContexts: number;
} {
  const pageContexts = [{ context: "purchase-guard/checkout-form", confidence: "high" }] as const;
  const first = scanner.scan(document, { pageContexts });
  const second = scanner.scan(document, { pageContexts });
  const contextFinding = first.findings.some(
    (finding) => finding.ruleId === "purchase-guard/checkout-form-return-policy",
  );
  if (!contextFinding) {
    throw new Error("expected Purchase Guard context-gated DOM finding");
  }
  if (
    !scanner.taxonomy.categories.some((category) => category.id === "purchase-guard/return-policy")
  ) {
    throw new Error("expected Purchase Guard category metadata");
  }
  if (
    !scanner.taxonomy.pageContexts.some((context) => context.id === "purchase-guard/checkout-form")
  ) {
    throw new Error("expected Purchase Guard page-context metadata");
  }
  try {
    scanner.scan(document, {
      pageContexts: [{ context: "purchase-guard/undeclared-form", confidence: "high" }],
    });
    throw new Error("undeclared DOM page context was accepted");
  } catch (error) {
    if (!(error instanceof ScannerPolicyError)) throw error;
  }
  return {
    findings: first.findings.length + second.findings.length,
    reused: true,
    toolVersion: first.toolVersion,
    contextFinding,
    taxonomyCategories: scanner.taxonomy.categories.length,
    taxonomyPageContexts: scanner.taxonomy.pageContexts.length,
  };
}
