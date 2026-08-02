# Third-party corpus fixtures

Six pages in this corpus were not written here. They are reduced copies of files from three
open-source projects, each carrying a licence that permits redistribution. This file is the
attribution those licences ask for; `provenance.json` beside it is the machine-readable record, and
`scripts/check-third-party-fixtures.mjs` fails if the two disagree or if a fixture drifts from what
is recorded.

**None of them was modified to make a rule fire.** The reduction is uniform, mechanical, and
verified: every fixture was scanned before and after, and the rule ids reported are identical.

| Fixture | Source | Commit | Original path | Licence | Copyright |
| --- | --- | --- | --- | --- | --- |
| `dads-modal-dialog-ja.html` | [design-system-example-components-html](https://github.com/digital-go-jp/design-system-example-components-html) | `55b5f3cc` | `src/components/modal-dialog/playground.html` | MIT | デジタル庁 |
| `dads-notification-banner-ja.html` | [design-system-example-components-html](https://github.com/digital-go-jp/design-system-example-components-html) | `55b5f3cc` | `src/components/notification-banner/warning.html` | MIT | デジタル庁 |
| `semantic-ui-login-en.html` | [Semantic-UI](https://github.com/Semantic-Org/Semantic-UI) | `597843ab` | `examples/login.html` | MIT | Jack Lukic and the Semantic-UI contributors |
| `semantic-ui-homepage-en.html` | [Semantic-UI](https://github.com/Semantic-Org/Semantic-UI) | `597843ab` | `examples/homepage.html` | MIT | Jack Lukic and the Semantic-UI contributors |
| `tabler-modal-en.html` | [tabler](https://github.com/tabler/tabler) | `4d04c102` | `core/js/tests/visual/modal.html` | MIT | The Tabler Authors |
| `tabler-alert-en.html` | [tabler](https://github.com/tabler/tabler) | `4d04c102` | `core/js/tests/visual/alert.html` | MIT | The Tabler Authors |

## What was removed

The same six rules were applied to every fixture, by `parse5` — the parser `@fairux/html` reads
pages with — and never by hand:

- every `<script>`, `<link>`, `<style>`, `<iframe>` and `<noscript>` element
- the `src` of every `<img>`, keeping the element and its `alt`
- every form `action`
- inline event handler attributes
- absolute `http(s)` link targets, rewritten to `#`
- attribute values that embed markup, replaced with `#removed`

What is kept is what a rule reads: the parent and sibling relationships between controls, labels and
their inputs, headings, button and link text, `role`, `aria-*`, `hidden`, `disabled`, `checked`, and
the text next to a control. No analytics, no tracking pixel, no font, no external image, no API
endpoint, no session identifier, no personal data, and no order number — none of the six contained
any of those before reduction either.

## Licence texts

All three sources are under the MIT licence. Its terms require the copyright notice and the
permission notice to travel with the copies, which is what this file carries.

### デジタル庁 — design-system-example-components-html

> MIT License
>
> Copyright (c) 2025 デジタル庁

### Semantic-UI

> The MIT License
>
> Copyright Jack Lukic and the Semantic-UI contributors

`LICENSE.md` in that repository states the MIT terms without naming a holder; the name here is taken
from the `author` field of its `package.json` at the pinned commit and is recorded as an inference,
not as a quotation.

### tabler

> The MIT License (MIT)
>
> Copyright (c) 2018-2026 The Tabler Authors

The full text of the MIT licence is at each source repository's `LICENSE` path, recorded per fixture
in `provenance.json`.

## What these fixtures do and do not establish

They establish that FairUX has been measured against licensed UI fragments **this project did not
author**, in markup conventions it did not choose.

They do **not** establish representativeness of live commercial websites. Design-system examples and
component test pages are not drawn from the same distribution as a shipping checkout flow, and
nothing measured here should be reported as if they were. Evaluating permissioned pages from
production sites is separate work and is not what this corpus is.
