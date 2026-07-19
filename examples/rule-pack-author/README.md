# RulePack Author Example

This is a copyable external package shape for authors building a RulePack with `@fairux/sdk`.
It imports only the public SDK entry points:

```ts
import type { Rule, RuleMeta, RulePack } from "@fairux/sdk";
import { composeRulePacks, fairuxBuiltinRulePack } from "@fairux/sdk";
import { scanHtml } from "@fairux/sdk/html";
```

It does not import `@fairux/core`, `@fairux/rules`, `@fairux/html`, `@fairux/dom`, or workspace
source paths. Those packages are internal implementation details, not an external compatibility
contract.

After the SDK beta is published:

```bash
pnpm install
pnpm build
pnpm test
```

The example models a Purchase Guard-style product as a separate consumer. It adds namespaced
`purchase-guard/...` categories and page contexts, then composes the pack with
`fairuxBuiltinRulePack`. FairUX still returns UX risk signals only; this pack does not make legal,
fraud, safety, or compliance verdicts.
