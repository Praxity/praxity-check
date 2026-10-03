# PDF report v2

The check command reads PDF facts and renders pages in process with
@embedpdf/pdfium 2.15.1. A worker handles each PDF. No browser starts for PDF
checks. PDFs inside HTML folders and ZIPs are outside this command's coverage.

veraPDF and Java remain separate requirements for PDF/UA machine validation.
The default is --pdfua ua1. Select ua2 for PDF/UA-2, or off to disable that
validation explicitly. --verapdf, VERAPDF and PATH select the validator in that
order. Missing or failed validation produces incomplete coverage and exit 2.
The adapter was verified with veraPDF 1.30.2.

## Identity and evidence

New reports use schemaVersion "pdf-2", independently of HTML schema v4.
document records the original absolute path, byte count and SHA-256 of the
immutable snapshot used for extraction. The original PDF remains intact.
engine records the PDFium name, @embedpdf/pdfium package and exact package
version. build is null because the distributed package and wasm expose no
PDFium build number. buildLimitation explains that absence.

Engine evidence records engine identity, operation, passed or untested outcome,
diagnostics and any error. Operations are open, pages, fonts, images and words.
veraPDF evidence retains tool, args, stdout, stderr, exitCode and error, plus
version evidence. Older pdf-1 reports retain their original subprocess evidence.

Every worker operation has a 30-second deadline. A deadline terminates its worker.
The wasm ceiling is 512 MiB, checked after initialization, allocations and each
native call. Worker V8 limits do not bound wasm memory. Rendering also rejects
more than 16 million pixels; fact results retain the 32 MiB output limit.
Text extraction rejects more than 200,000 characters per page. Object traversal
is bounded at 100,000 objects and 64 nested forms; design evidence at 5,000
spans and 1,000 font styles per page. Exceeding a limit fails the operation.

## Facts and coordinates

metadata contains PDFium's document information strings, page count, encryption
and tag presence. PDF dates retain their raw D: syntax. Presence of tags is not
a conformance verdict.

pages contains page number, rotated display width and height, page rotation,
and MediaBox, CropBox, BleedBox, TrimBox and ArtBox. Display geometry uses the
intersection of CropBox and MediaBox. Missing optional boxes use
the PDF defaults. MediaBox and CropBox resolve page-tree inheritance; BleedBox,
TrimBox and ArtBox are page-local and default to effective CropBox.
Box values are normalized lower-left and upper-right pairs in
PDF default user space before rotation. UserUnit is not extracted or validated.

words groups reliable PDFium characters using whitespace, advance-box gaps
relative to transformed font size, line changes, size changes and rotation.
Rectangles are [left, top, width, height] in the rotated intersection of CropBox and MediaBox,
top-left origin, nominal PDF points. Ordinary word boxes enclose tight character
boxes. ActualText replacement words share their marked-content region box;
they do not have individually measured glyph positions. Extracted order is
PDFium's order, not a verified reading order. Unreliable Unicode mappings,
NUL, replacement values and non-text controls are omitted with review diagnostics.
Extraction includes visible annotation appearances, flattened in a separate copy
with the original effective page boxes preserved. Supported missing normal
appearances, including FreeText, are generated on that copy before flattening.
NoRotate appearance instances receive the renderer's inverse page rotation
around the annotation's top-left corner, so extracted rectangles match rendering.
Generation failures leave fonts, images and words untested and reject design spans.
The original document is used for rendering. AcroForm appearance state is
initialized to include field values and button captions without saved
appearances; no document, page or JavaScript action is invoked.

fonts lists fonts used to paint text in page objects, nested form XObjects and
visible annotation appearance streams. Unpainted font resources, Hidden and NoView
annotations are excluded. Invisible hides unknown subtypes only, matching normal
display rendering. Flattening an extraction copy exposes appearances
that PDFium's ink/stamp-only annotation object API cannot enumerate.
Each row has a name, embedded flag and page list. Names can omit subset prefixes;
subset status, font type, encoding, ToUnicode presence and PDF object IDs are
unavailable. Those fields are omitted rather than invented. The report's
coordinates.fonts describes these limits. font.embedding checks this inventory.

images lists painted raster objects, including nested forms and visible
annotation appearances, with pixel
dimensions, bitsPerPixel, numeric PDFium colorSpace, colorSpaceKnown, page, sequence number and
effective xPpi/yPpi. Soft masks remain internal to their parent images and do not
have separate rows. Object IDs and stencil classification are unavailable.
The inventory includes painted image objects without inventing a type field.
PPI uses the composed image-to-page matrix in default user space.

## Checks and incomplete evidence

--min-image-ppi requests review below the caller's threshold. It applies to
painted raster objects; soft masks have no separate rows. PPI is not a visual
quality verdict. --paper-size A4 or Letter compares MediaBox dimensions in
either orientation with the unchanged one-point tolerance. Physical printing
and UserUnit scaling remain untested.

text.extractable requests review when a page has no reliably extracted words.
With --max-sparse-words, page.sparse-content requests review of pages with at
most that many words and no raster objects with a known color space. Stencils
and other unknown-color-space images do not exempt sparse review. These are
review candidates.
Vector artwork, intentional whitespace and image purpose need a person.

evaluations distinguishes passed, failed, cantTell, inapplicable and untested.
Extraction passes mean facts were obtained, not that the PDF is accessible.
Failed opening, unsupported encryption, deadlines, ceilings and unavailable
inventories make the affected extraction rules untested and machineStatus
incomplete. Other inventories retain their completed results. Locked PDFs and
encrypted PDFs that open with an empty password are both rejected.

Review diagnostics remain needsReview even when extraction succeeds.
Empty font or image inventories can be valid. Findings retain document-scoped
occurrence IDs; inference never changes the machine verdict.

## PDF/UA evidence

veraPDF findings retain specification, clause, test number, requirement, error
and object context. Only explicit page context supplies a page location.
The adapter uses veraPDF's rules for tags, language, metadata, tables, graphics,
annotations and fonts. It does not implement another standards validator.

A validator exit 1 means completed validation with failures. Invalid,
contradictory, capped or wrong-profile evidence makes coverage incomplete.
pdfuaValidation.coverage records failedChecks, retainedChecks, omittedChecks
and per-rule counts. No PDF/UA conformance or assistive-technology claim follows
from machine validation alone. Physical-print and human review remain untested.

## Review bundles and design evidence

prepare-review file.pdf --tier inference --reviewer manual prepares a private
bundle. --checks selects accessibility, design or both; --focus selects visual
or usability. audience and use provide context. Up to 24 explicitly selected
pages or the deterministic default sample receive PNG overviews at 1600 pixels
high, page JSON facts, hashes, a manifest, a review schema and review instructions.

New manifests use pdf-review-bundle-3 for canonical and legacy-focus preparation.
renderer records the engine identity. Page artifacts record render dimensions,
image/fact hashes, operation parameters and diagnostics. The manifest's SHA-256
binds pdf-review-4 imports to the exact evidence, context and selection.
Legacy reviews remain document-bound and say which evidence binding is missing.

--design-evidence adds pdf-design-evidence-2. Each page retains
page-N-design.json with PDFium spans, font sizes, families, foreground colours,
bold/italic flags, hashes and diagnostic evidence. Measurements describe text
envelopes and adjacent text-box gaps, not drawn rules or visible whitespace.
--min-text-size-pt compares transformed extraction sizes with an explicit
caller requirement; it is not a universal readability threshold.
Up to two 144 DPI detail crops target the smallest font and the largest measured
adjacent text-box gap. Crops use the same rotated CropBox coordinates as spans,
including rotated, offset and fractional pages. A supplied geometry mismatch
leaves crop mapping unsupported and keeps the overview.

Source spans and words can include hidden or clipped text. Render inspection
must establish visible defects, contrast concerns and reader consequences.
Font count, whitespace and mixed orientation alone are not defects.
Model review remains inference, even when evidence hashes match.

Verification still accepts pdf-review-bundle-1 and -2 and their historical
artifact formats. Existing pdf-review-1 through -4 imports remain accepted under
their original binding rules. A pdf-review-4 import accepts a bound -2 or -3
bundle. Changing the renderer requires a newly prepared bundle and review.

## Comparing reports

compare-pdf BEFORE.json AFTER.json accepts pdf-1 and pdf-2 reports. --json emits
structured comparison to stdout. Comparison groups rule, message and page;
it does not establish object identity or when an issue was introduced.
Changed schema or engine versions prevent a disappearing finding from being
declared resolved. Only comparable completed machine coverage can do that.
Review observations remain unverified when they disappear.

Reports and bundles can contain private content and local paths. Review them
before sharing. Generated CLI reports include feedback.schemaVersion "feedback-1"
as described in the shared report schema guide.
