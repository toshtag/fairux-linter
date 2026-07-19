# RulePack testing

External RulePack authors should test the same contract that production scanners use:
`composeRulePacks()`, `scanHtml()`, reusable scanners, and DOM scans from `@fairux/sdk`.

The repository keeps authoring fixtures under
[`tests/fixtures/sdk-custom-rule-pack`](../tests/fixtures/sdk-custom-rule-pack). Valid fixtures
compose and scan successfully. Invalid fixtures must fail with `RulePackError`.

## Recommended Test Shape

```ts
import { describe, expect, it } from "vitest";
import { composeRulePacks, fairuxBuiltinRulePack, RulePackError } from "@fairux/sdk";
import { scanHtml } from "@fairux/sdk/html";
import { purchaseGuardRulePack } from "../src/index.js";

describe("purchaseGuardRulePack", () => {
  it("composes with the built-in pack", () => {
    const composed = composeRulePacks([fairuxBuiltinRulePack, purchaseGuardRulePack], {
      includeExperimental: true,
    });

    expect(composed.taxonomy.categories.map((category) => category.id)).toContain(
      "purchase-guard/return-policy",
    );
  });

  it("scans scoped checkout content", () => {
    const report = scanHtml("<main><form><input><button>Buy now</button></form></main>", {
      includeExperimental: true,
      rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
      pageContexts: [{ context: "purchase-guard/checkout-form", confidence: "high" }],
    });

    expect(report.findings.map((finding) => finding.ruleId)).toContain(
      "purchase-guard/missing-return-policy",
    );
  });

  it("rejects undeclared external categories", () => {
    expect(() =>
      composeRulePacks([{ ...purchaseGuardRulePack, taxonomy: undefined }]),
    ).toThrow(RulePackError);
  });
});
```

## Valid Fixtures

Cover at least:

- a minimal pack using a built-in category;
- a namespaced taxonomy category;
- an external page context with caller-supplied scan context;
- dictionary groups for every claimed locale;
- a Purchase Guard-style pack that stays outside FairUX product boundaries.

## Invalid Fixtures

Cover at least:

- duplicate rule IDs;
- undeclared external categories;
- wrong namespace ownership;
- category parent cycles;
- undeclared external page contexts;
- invalid locale tags;
- sparse arrays;
- inherited metadata or class-backed metadata;
- malformed findings returned by `evaluate()`.

Invalid tests are as important as positive tests. They prove that authoring mistakes fail before
they become unstable public reports.

## Packed Consumer Proof

Local workspace tests can accidentally pass by importing source files. Before publishing, verify a
packed tarball in a clean project:

```bash
pnpm pack
mkdir /tmp/my-rule-pack-smoke
cd /tmp/my-rule-pack-smoke
npm init -y
npm install /path/to/your-rule-pack.tgz @fairux/sdk@0.1.0-beta.1
```

Then run a small root, HTML, DOM, and TypeScript consumer test against the installed package.
The FairUX SDK release workflow uses the same exact-tarball principle for `@fairux/sdk`.

This repository also verifies the copyable authoring example itself:

```bash
pnpm test:rule-pack-author-example
```

That command packs `@fairux/sdk`, installs it into a temporary copy of
`examples/rule-pack-author`, and runs the example package's own `build` and `test` scripts without
falling back to workspace source imports.
