# PDF report v1

`praxity-check check file.pdf --json report.json` checks a direct PDF with
Poppler's `pdfinfo`, `pdffonts`, `pdfimages`, and `pdftotext`, plus the veraPDF
CLI and its Java runtime. Install these tools separately. No browser starts. HTML folders and ZIPs keep their existing
coverage; PDFs inside them are not scanned by this command.

PDF checks now run veraPDF's `ua1` machine profile by default. Use `--pdfua ua2`
for PDF/UA-2, or `--pdfua off` to explicitly request only the Poppler checks.
Select the executable with `--verapdf /path/to/verapdf`, the `VERAPDF` environment
variable, or `verapdf` on PATH, in that order. Configure its Java runtime as the
veraPDF installation requires. A missing validator produces incomplete coverage
and exit 2; it is not silently skipped. The adapter was verified with veraPDF
1.30.2. It requests all failed checks rather than the default truncated display.

Use `--min-image-ppi 150` to request review of raster images below 150 effective
PPI. This is a chosen review threshold, not a universal print requirement.
Masks are excluded. `--paper-size A4` or `--paper-size Letter` compares MediaBox
dimensions in default user space, allowing either orientation and one point of
rounding tolerance. It does not validate UserUnit scaling or physical printing.

The JSON discriminant is `schemaVersion: "pdf-1"`, independent of HTML report
schema v4. `document` identifies the original absolute path, byte count, kind,
and SHA-256 of the exact private snapshot used for every extraction. The snapshot
is read-only and removed after the report captures evidence. The original PDF
is never rewritten. Each evidence entry retains the tool, arguments, raw stdout,
stderr, exit code, and error when present. Separate `-v` entries record tool
versions. Argument paths to the temporary snapshot will no longer exist.

`facts` contains metadata, per-page boxes and rotation, fonts, image dimensions
and effective PPI, and extracted words. Boxes use PDF default user space with a
bottom-left origin. Word rectangles retain Poppler TSV's top-left page
presentation in points; they are **not** normalized to an unrotated CropBox.
Do not use them as overlay anchors without a tested coordinate conversion.
Image locations identify a page only, because Poppler does not provide a
placement rectangle in its image inventory. UserUnit is not extracted.

`evaluations` distinguishes `passed`, `failed`, `cantTell`, `inapplicable`, and
`untested`. Extraction passes mean facts were obtained, not that the document
is accessible. Missing tools, failed commands, unsupported encryption, and
unrecognized parser output produce `untested` and an `incomplete` machine
status. Recoverable Poppler stderr diagnostics remain manual review items.
Empty font or raster inventories can be valid on vector-only pages.

`findings` records nonembedded fonts, requested MediaBox mismatches and each
failed veraPDF machine check. Validator findings retain specification, clause,
test number, original requirement, error and object context. Page locations are
included only where an explicit page context identifies one. The adapter reuses
the validator's rules for tags, language, metadata, headings, tables, graphics,
annotations and fonts; it does not implement a second standards validator.

`pdfua.machine` reports the selected machine profile result. A validator exit 1
is a completed validation with failures, not an execution error. Missing, malformed, contradictory or wrong-profile reports remain untested/incomplete.
When a normal validation job supplies consistent failed-rule totals but omits
some check details, Check retains the validated findings and keeps the run
incomplete with exit 2. `pdfuaValidation.coverage` records total, retained and
omitted failed checks, including counts for each failed rule. The CLI names
the rules with missing evidence. A failed rule with no retained details has no
invented occurrence or location. Raw validator JSON remains in evidence.
`needsReview` separately records low-PPI images and tool diagnostics. Items
have a rule, severity, confidence, remedy, evidence, and document-hash location.
Occurrence IDs include the document hash, so a regenerated file cannot inherit
an old occurrence identity. PDF baseline and machine-finding disposition import are not
supported in this version. Optional inference reviews use a separate format below. HTML `--baseline`, `--scenarios`, and network options
are rejected for PDF input. `--min-confidence` is accepted; all current machine
findings have high confidence, so its values give the same exit result.

Exit 0 means extraction completed without machine findings. Exit 1 means
machine findings exist. Exit 2 means invalid input/options or incomplete
extraction, even if some facts were obtained. Review candidates do not change
exit 0 into exit 1. JSON is still written for extraction failures. Failed JSON
writes preserve an existing report; output paths that alias the source PDF are
rejected.

Overall PDF/UA conformance, human visual review, physical printing and
assistive-technology testing remain explicitly untested. Optional model inference
does not complete these evaluations. A passed machine profile
does not settle human checkpoints such as meaningful reading order or alt-text quality. Tagged metadata is a
fact, never proof of meaningful tags, reading order, alt text, or accessible
tables. There is no conformance claim or automatic PDF repair. Image treatment
and dithering belong in source generation, not this checker.

Feedback uses the same findings for people and agents. Each message states the
problem; its remedy names a source or export change, or a review step when a fix
cannot be determined automatically. Reviewed wording covers 11 exact PDF/UA-1
rules. Other rules retain the validator's original error rather than guessing a
fix. Exact requirements and object contexts remain in evidence for every rule.

The CLI groups repeated problems and shows the first location and occurrence
count. JSON retains every occurrence, its ID, location and evidence. Wording
changes do not change occurrence IDs. Missing page information stays at document
level; it does not imply that the problem affects every page. Fixes, review
questions and checks that did not run are presented separately. After a source
change, regenerate and recheck the PDF before applying feedback to the revision.


## Optional inference review

Automated checks run without a model. To ask an agent to review visible design,
prepare a private bundle:

```sh
praxity-check prepare-review file.pdf --checks design --tier inference --focus visual --output /private/new-review
praxity-check prepare-review file.pdf --checks design --tier inference --focus usability --output /private/new-usability-review --audience "New staff" --use "Complete the first-day checklist"
```

Use a new output directory; existing directories are rejected. Without `--output`,
the command creates a private temporary directory and prints its path. The bundle
contains selected page images, extracted words and geometry, a manifest, a review
prompt and a JSON schema. It contains document content: keep it private and delete
it when finished. Preparation runs Poppler locally; it does not call a model or
upload content. Rendering also requires Poppler's `pdftoppm`.

Visual and usability are review focuses within the inference tier. Visual covers
visible layout and legibility. Usability asks
whether the stated audience can complete the intended task. `--audience` and
`--use` supply optional context for either focus. Each bundle requests one focus.
The default selects up to eight evenly spaced pages, including the first and last.
Use `--pages 1,3,7` to choose pages; each bundle allows at most 24. Each render has
a maximum dimension of 1600 pixels and a 30-second timeout. Small print details
may need a closer inspection outside this bundle. Page geometry and actual render
dimensions accompany each image. Text coordinates retain their original Poppler
convention; they are not image overlay coordinates.

Give `review-prompt.md` and the bundle to a model capable of inspecting the images.
Rubato and other agents use the same files. The reviewer returns JSON matching
`review.schema.json`, records its actual model identifier, and declares only pages
it inspected. Import that result with:

```sh
praxity-check check file.pdf --checks design --tier inference --review review.json --review-bundle /private/new-review/manifest.json --json report.json
```

Import rejects unknown or missing fields, stale document hashes, invalid tiers,
invalid page coverage, findings outside that coverage and missing evidence or
feedback. A review file is limited to 4 MiB, 24 reviewed pages and 200 findings.
Version 4 imports require `--review-bundle <bundle>/manifest.json`. The importer
checks the PDF identity, exact manifest hash, image and facts hashes, any design
artifacts, focus, domains and selected pages. The manifest hash also binds task
context. Partial reviews may list a subset of selected pages; omitted pages stay
unreviewed. Hash verification cannot prove image inspection or correct inference.

`inferenceReviews` holds imported review envelopes separately from machine
`findings` and `needsReview`. Each inferred concern identifies its page, confidence,
observed problem, reader consequence, proposed action, verification step and
evidence observation. Imported findings normalize to stable `id`, `rule`,
`location`, `message`, `remedy`, `confidence`, `consequence`, `verification`,
`provenance` and `evidence` fields. `provenance` records method, the canonical inference tier, review focus and model.
Version 2 reviews classify each concern as `observed-defect`, `needs-context`,
or `suggestion`. These are the model's classifications, not confirmed verdicts.
Version 1 reviews remain importable and default to `needs-context`. Generated
legacy bundles use version 2. Canonical `--tier inference` bundles use version 4,
which adds `bundleSha256` to version 3's `tier: "inference"`, `focus`, selected
`checks` and a `check` domain for each finding. Versions 1–3 remain importable
and are explicitly marked `document-only` in `evidenceBinding`; they cannot
verify which prepared evidence or context the reviewer used. Version 4 imports
are marked `bundle`. Explicit domain selections reject ambiguous legacy reviews.
The CLI prints the category beside each concern.
Inferred concerns receive moderate severity pending confirmation. IDs bind
the document hash, tier, page and evidence. The submitted origin statement is
retained as a reviewer hypothesis in evidence; uncertain source causes should be stated as hypotheses.
Page regions are not accepted because this workflow does not establish reliable
region coordinates. The CLI prints the same information under a separate inferred
review label. Inferences do not change machine status, machine evaluations or exit
codes. `check --tier inference --review ...` extracts supporting facts only and
skips deterministic quality and conformance checks; it requires an imported review.
An explicit `--tier deterministic` rejects `--review`. Omitting the tier retains
the legacy combined report. Unreviewed pages remain outside coverage; an empty findings array is not a
whole-document pass, an accessibility verdict or a conformance claim. After changing
the PDF, prepare and review the new revision.

Preparation currently requires all Poppler fact extractions to succeed. A font
or image inventory failure can therefore block a visual bundle even when the
page could render; run `check` for the failed extraction and its diagnostics.


Pages without extracted words produce review candidates by default. Use
`--max-sparse-words 8` to additionally flag pages with one to eight extracted words
and no raster images. This does not measure vector artwork, visible content
coverage or intended whitespace. Keep intentional covers and writing areas;
change pagination only after inspecting the page. Missing extraction remains
untested, rather than being treated as an empty page.

Repeat `--review` for separate page batches from the same bundle. Each batch
retains its own page coverage and reviewer. One `--review-bundle` applies to all
reviews in that invocation; use separate reports for different bound bundles or
focuses. Legacy unbound reviews can still combine focuses without a bundle.

Model review is experimental. The initial Luna max trials missed a clipped
instruction and reported a nonexistent writing-space defect on a clean control.
Review the supporting page before applying a proposed fix. A fresh empty review
is useful evidence, but it is not proof that all defects were repaired.


## Compare PDF revisions

```sh
praxity-check compare-pdf before.check.json after.check.json
praxity-check compare-pdf before.check.json after.check.json --json
```

Comparison reads two `pdf-1` reports. `--json` writes structured output to stdout;
it is not an output filename. A successful comparison exits 0, including when
findings remain. Invalid input exits 2. Use the original check reports for their
check outcomes. Each comparison input is limited to 64 MiB.

The output identifies both document hashes and keeps occurrence IDs within their
revision. Groups match rule, message and page, plus the observation for inference.
They describe reported problems, not proven object identity across exports.
Newly reported does not mean newly introduced. Reduced counts do not identify
individual repairs, and page moves are not matched automatically.

A missing machine finding is resolved only when comparable complete checks
establish absence. Different policy, missing tool versions, incomplete coverage
or changed page counts prevent that conclusion. Unknown rules remain unverified.
Missing model concerns and review questions always remain unverified, even after
an empty fresh review. Comparison is evidence for the next repair decision, not
a conformance verdict or a record of human acceptance.

## Sources behind the review boundaries

[W3C PDF3](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF3) describes reading
and focus-order testing. A rendered page alone cannot establish that result.
[W3C PDF1](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF1) bases image
alternatives on equivalent meaning, not string presence.
[W3C PDF6](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6) addresses table
structure and relationships. The [Matterhorn Protocol](https://pdfa.org/resource/the-matterhorn-protocol/)
distinguishes machine and human assessments for PDF/UA-1. These inform Check's
coverage boundaries; their examples are not bundled as product fixtures.
