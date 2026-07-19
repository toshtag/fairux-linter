import type { RulePack } from "@fairux/sdk";
import { missingReturnPolicyRule } from "./rules/missing-return-policy.js";

export const purchaseGuardRulePack = {
  meta: {
    id: "@purchase-guard/jp-commerce",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Purchase Guard JP Commerce",
    status: "experimental",
  },
  taxonomy: {
    categories: [
      {
        id: "purchase-guard/return-policy",
        title: "Return policy",
        description: "Signals about return, refund, or exchange terms in purchase flows.",
      },
    ],
    pageContexts: [
      {
        id: "purchase-guard/checkout-form",
        title: "Checkout form",
        description: "Checkout forms where purchase terms should be visible before submission.",
      },
    ],
  },
  rules: [missingReturnPolicyRule],
} satisfies RulePack;

export { missingReturnPolicyRule } from "./rules/missing-return-policy.js";
