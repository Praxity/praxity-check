# 0005: PDFium extraction and rendering parity

## Status

Accepted. Records existing behaviour; no runtime change.

## Context

Inventories and raster output must describe the same displayed document, including visible annotation appearances and inherited geometry.

## Decision

- In `src/pdf-engine.ts`, `openPdf` gives each document a worker and each operation a 30-second deadline. The default 512 MiB WebAssembly ceiling permits large documents and 1600-pixel overviews; V8 resource limits do not bound WebAssembly growth. In `src/pdf-engine-worker.ts`, `memory` accesses the runtime HEAPU8 export omitted from package declarations, and the `p` proxy checks memory after native calls, including page/object loops.
- `annotationVisible` matches normal display rendering, including widgets: Hidden and NoView suppress display; Invisible applies to unknown subtypes, not known ones. `generatedAppearanceSubtypes` records which missing normal appearances PDFium generates; widgets use the form environment and Stamp/unsupported subtypes require saved appearances.
- `extractionDocument` flattens a separate analysis copy so appearances become ordinary form objects; the original remains available for rendering. Loading form views creates missing normal appearances, including button captions, without invoking document, page or JavaScript actions. Adjust flatten visibility to match the renderer, allow a borderless Link to succeed without painting, and match appearance instances in annotation order while excluding Popup/empty appearances.
- `extractionDocument` materializes effective boxes before flattening and restores them afterward because flatten reads local boxes and overwrites MediaBox with CropBox. Reopen pages to parse generated content. A partial flatten failure is retained and must make later inventory requests fail too.
- `geometry` inherits only MediaBox and CropBox; other boxes default to effective CropBox. FS_RECTF and direct box getters use different top/bottom ordering. `presentation` clips CropBox to MediaBox for display while facts retain raw boxes.
- `noRotateTransform` counters page rotation around the annotation's PDF top-left to match CPDF_Annot. `compensateAnnotationRotation` edits flattened appearance instances on every reopened extraction page, preserving shared streams and ordinary page text.
- `characters` records missing Unicode mappings/replacement glyphs as loss instead of counting PDFium character-code fallback as trustworthy text. `wordBreak` uses loose advance boxes so tight glyph bearings do not split digits or italic text. `replacements` gives an outer ActualText replacement ownership of enclosed marked content.
- `render` enables FPDF_ANNOT, disables LCD text to preserve the intended pixels, and draws widgets explicitly with the same native display matrix. That matrix already includes CropBox and rotation. Explicit scale preserves fractional dimensions instead of rounding the page viewport.
- In `src/pdf-print.ts`, `evaluatePdfPrint` treats missing inventories as failed extraction and empty inventories as successful extraction. Unknown colour spaces cannot exempt sparse-page review: PDFium does not identify stencils' colour space, so the code must preserve coverage without inventing an image type.

Sources: corresponding comments and implementations at `43dbc10`; `src/pdf-engine.ts`'s `pdfCoordinates`; `test/pdf-engine.test.ts`, `test/pdf-design.test.ts` and `test/pdf-print.test.ts`. Platform behaviour recorded by the comments comes from PDFium's CPDF_Annot renderer, FPDFPage_Flatten and form-fill APIs as used by @embedpdf/pdfium 2.15.1.

## Consequences

Changes to these rules require updated evidence and tests through the affected module interfaces. Removing comments does not broaden what the existing checks establish.
