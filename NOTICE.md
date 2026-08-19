# Notices and acknowledgements

## Praxity Audit

Copyright © 2026 Ariel Harlap.

Canonical attribution: **Praxity Audit by Ariel Harlap**

Project: <https://github.com/Praxity/praxity-audit>

Praxity Audit is community source software for reducing accessibility debt in
learning packages and interactive websites. See `LICENSE` and `LICENSING.md`
for permitted uses and commercial-licensing requirements.

## Contributors

- Ariel Harlap — creator and current contributor

External code contributions are not accepted during the public alpha. Git
metadata alone is not used to infer copyright ownership or contributor credit.

## Licence text

The licence includes the unmodified
[PolyForm Perimeter License 1.0.1](https://polyformproject.org/licenses/perimeter/1.0.1),
copyright PolyForm Project Inc. The PolyForm Project separately permits reuse
of its licence texts. The Praxity Community Permission is specific to Praxity
Audit.

## Runtime dependencies

Dependencies are installed by the package manager and retain their own terms:

- `@axe-core/playwright` and `axe-core` 4.12.1 — Mozilla Public License 2.0;
  maintained by Deque Systems. `axe-core` also ships its own third-party notice.
- Guidepup 0.24.1 — MIT; Copyright (c) 2023 Craig Morten.
- Playwright 1.62.1 — Apache License 2.0; Microsoft Corporation.
- `yauzl` 3.4.0 — MIT; Copyright (c) 2014 Josh Wolfe.

Development dependencies include TypeScript under Apache-2.0 and type/support
packages under MIT terms. The release lockfile is the authoritative version
inventory.

## Methodology and standards acknowledgements

The following informed the methodology but are not incorporated as Praxity
Audit code:

- [Community Access Accessibility Agents](https://github.com/Community-Access/accessibility-agents),
  MIT, Copyright (c) 2026 Taylor Arndt. Praxity Audit distills independently
  implemented checks and review hypotheses from accessibility knowledge that
  included locally adapted versions of these agents; their agent files are not
  distributed here.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), its Understanding and Techniques
  documents, and the [WAI-ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/).
- Manuel Matuzović, [My HTML boilerplate in 2026](https://matuzo.at/blog/2026/html-boilerplate),
  which informed the page-title, operating-system text-scaling, and declared
  colour-scheme checks; no article text or code is incorporated here.
- axe-core rule descriptions included in audit results originate from axe-core.
