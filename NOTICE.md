# Notices and acknowledgements

## Praxity Check

Copyright © 2026 Ariel Harlap.

Canonical attribution: **Praxity Check by Ariel Harlap**

Project: <https://github.com/Praxity/praxity-check>

Praxity-authored code in Praxity Check by Ariel Harlap is available under the
[MIT licence](LICENSE). See [LICENSING.md](LICENSING.md) for details.

## Contributors

- Ariel Harlap — creator and current contributor

External code contributions are not accepted during the public alpha. Git
metadata alone is not used to infer copyright ownership or contributor credit.

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
Check code:

- [Community Access Accessibility Agents](https://github.com/Community-Access/accessibility-agents),
  MIT, Copyright (c) 2026 Taylor Arndt. Praxity Check distills independently
  implemented checks and review hypotheses from accessibility knowledge that
  included locally adapted versions of these agents; their agent files are not
  distributed here.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), its Understanding and Techniques
  documents, and the [WAI-ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/).
- Manuel Matuzović, [My HTML boilerplate in 2026](https://matuzo.at/blog/2026/html-boilerplate),
  which informed the page-title, operating-system text-scaling, and declared
  colour-scheme checks; no article text or code is incorporated here.
- T-Mobile USA, [MagentaA11y](https://github.com/tmobile/magentaA11y), Apache
  License 2.0, reviewed at commit `1581528deb053f868b1881d7bb3b2e9fb9274036`.
  Its web acceptance criteria informed the custom-checkbox and slider actions,
  plus the tooltip hover, focus, pointer-persistence, timed-persistence, and
  Escape evidence. No MagentaA11y code or text is incorporated here.
- axe-core rule descriptions included in audit results originate from axe-core.

## PDF engine

PDF facts and page rendering use @embedpdf/pdfium 2.15.1, MIT wrapper,
with PDFium under BSD terms. Wrapper, PDFium and component licence texts
are retained in notices/pdfium and copied into standalone artifacts.
The component notice index identifies source URLs and hashes.
This software includes work of the FreeType Project, www.freetype.org.
PDFium includes standard-font substitutes originally copyright Foxit Software.

## Separately installed components

Check packages do not include the browser, Java or veraPDF. `check setup`
downloads these from upstream after consent. Chromium headless shell retains
its BSD licence and bundled notices; Playwright also installs FFmpeg under
LGPL-2.1+ and Windows Winldd. Temurin Java is GPL-2.0 with the Classpath Exception.
veraPDF is available under GPL-3.0+ or MPL-2.0+. Their notices remain in the
installed files. See [component archives](docs/offline-components.md).

## Fixture and component-pin provenance

`scripts/package-pdf-fixture.mjs` generates an original synthetic PDF. Its Type 3 A glyph avoids host fonts and third-party assets.

The Temurin Java hashes in `src/components.ts` were checked against the adjacent `.sha256.txt` release assets at <https://github.com/adoptium/temurin17-binaries/releases/tag/jdk-17.0.20.1%2B1>. Browser archive hashes in `browserArchives` were measured from the official archives selected by Playwright 1.62.1. Archive URLs and hashes remain in the component manifest.
