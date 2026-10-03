# PDF engine fixtures

All PDFs here are generated test documents.

Run node scripts/pdf-engine-fixtures.mjs to regenerate the page, form,
annotation, spacing, replacement-text, Unicode, raster and Type 3 font fixtures. The Type 3
glyph comes from scripts/package-pdf-fixture.mjs and uses original vector paths.

encrypted-open.pdf and encrypted-locked.pdf were generated with ReportLab's
Canvas and StandardEncryption, using invariant output and standard fonts.
The first has an empty user password; the second has a nonempty user password.
Neither contains third-party document content.
