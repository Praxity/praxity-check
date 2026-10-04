# Praxity Check

Find accessibility issues in eLearning exports, interactive websites and PDFs
before they reach learners.

## Why use it

eLearning exports from authoring tools and interactive websites created with
generative AI can contain accessibility barriers. Focus can disappear, menus
can trap keyboard users, colour contrast can fail when someone hovers over an
interactive element, and page updates can go unannounced. Checking your HTML
exports helps you find issues early, before they create barriers for learners.

Run Praxity Check when evaluating eLearning authoring tools or during iterative
development of an online course. It locates and describes likely accessibility
issues in your HTML and PDFs so you can review them and decide what to fix. On macOS, it
can also use VoiceOver to test specific interactions one at a time and capture
what was announced.

## What it is

Praxity Check is a local command-line tool. Give it a folder or zip file to check
the HTML pages inside, or a PDF to check its accessibility and selected design
requirements. PDF facts and renders use bundled PDFium wasm. PDF/UA validation uses veraPDF and Java.

Status: alpha. Run from source with the steps below. Interaction review,
PDF model review and VoiceOver evidence are experimental. Review model claims
against the retained evidence before changing your content.

## Automated checks

For HTML, the `check` command scans every page and can produce findings or stop CI at
the confidence level you choose. It runs:

- axe-core's browser checks.
- keyboard traps, focus order, mouse-only controls, character shortcuts, and
  pointer-down activation.
- focus visibility, focus obscuring, and keyboard-operable scroll regions.
- text, control, graphical, hover, and focus-state contrast.
- 320-pixel reflow, text-spacing clipping, and 200% operating-system text
  scaling when a page opts in.
- contrast and focus visibility in declared dark colour schemes.
- long automatic motion and audio autoplay.
- narrow checks for image alternatives and ambiguous link names, plus a possible
  issue to review when several pages share one title.

The pages run locally. During `check` and `prepare-review`, ordinary web requests
outside the local check server, including WebSocket connections, are blocked by
default. Only run it on packages you trust; Praxity Check is not designed to contain
deliberately malicious HTML.

For HTML, the terminal summary names the confidence threshold used for its issue count.
It groups repeated focus coverage notes by behaviour and counts affected pages.
When checks do not run, it prints `Checks not run: 7 on 2 pages` beside the
checked-page count. JSON retains the counts and each check's reason, even when
no findings reach the threshold.
Add `--json report.json` to save every issue, every possible issue to review,
and coverage notes for each page and state, with evidence. The `--min-confidence`
option controls which findings are shown and which make the command exit with an error.

HTML, SCORM and PDF reports share a feedback format for findings, review
questions, suggestions and coverage. See the [schema guide](docs/report-schema-v4.md)
for fields, evidence links and migration from v3.

## Quick start

Requirements: Node 22.18+ and pnpm 11.5.3.

```bash
git clone https://github.com/Praxity/praxity-check.git
cd praxity-check
pnpm install --frozen-lockfile
node src/cli.ts setup
node src/cli.ts check /absolute/path/to/site/dist --min-confidence medium
```

For HTML checks, the target may be a folder or zip. Add `--json report.json` to save the full
results and `--baseline previous-report.json` to compare exact occurrences with
a reviewed prior report. Use `--scenarios check-scenarios.json` to scan states revealed by safe
click, key, selection, and wait actions. The [usage guide](docs/using-it.md#named-rendered-states)
documents the JSON format. Run `node src/cli.ts --help` to see every option.

Reports and evidence files can contain course content, local paths, requested
URLs, and VoiceOver speech. Review them before sharing.

The command exits with `0` when it finds no issues at the selected confidence
level, `1` when it finds issues, and `2` when the check cannot run. Possible
issues that need a person to decide appear under `needsReview` in the JSON
report. They do not change the exit code.

## Select checks and evidence

`--checks accessibility|design|accessibility,design` selects what to assess.
`--tier deterministic|inference` selects how evidence is assessed, consistently
across HTML folders, SCORM ZIPs and PDFs. With either selection flag, checks default to accessibility. Add design when
you need it. Deterministic checks use fixed rules and
measurements. Inference reviews require a reviewer and never establish machine
conformance, even when their confidence is high.

```sh
node src/cli.ts check course.zip --checks accessibility --tier deterministic
node src/cli.ts check handout.pdf --checks design --tier deterministic --paper-size A4
node src/cli.ts prepare-review handout.pdf --checks design --tier inference --focus visual --design-evidence --output /private/new-review
node src/cli.ts check handout.pdf --checks design --tier inference --review /private/review.json --review-bundle /private/new-review/manifest.json --json report.json
```

HTML design checks are not implemented. Requesting them rejects the run before
launching a browser, including mixed accessibility/design requests. HTML inference
uses `prepare-review --checks accessibility --tier inference --output <new-directory>`
to prepare an importable bundle. After reviewing it, use `check --tier inference
--review <bundle>/review.json`. This imports retained evidence without launching a
browser or running deterministic checks. Omitting `--tier` with `--review` runs
deterministic checks alongside the review; only deterministic findings affect
the failure exit code.

PDF accessibility includes PDF/UA machine validation. Design includes paper size,
image PPI and sparse-page checks. Font embedding and missing extracted text are
shared checks. Supporting fact extraction runs for either domain. Inference-only
PDF runs extract supporting facts and import reviews without running deterministic
quality checks or the PDF/UA validator. Use a separate deterministic run for those.
New PDF reviews require `--review-bundle <bundle>/manifest.json` at import. The review
binds the exact prepared manifest, including context, selected pages and artifact hashes.
Changing the PDF, renders, facts or context requires a new review. Legacy v1–v3
reviews remain importable but are marked as bound only to the PDF bytes.
`--design-evidence` adds PDFium text measurements and detail crops to design review
bundles. Optional `--min-text-size-pt 10` states a requirement for all extracted
text; it is not a universal readability threshold. Measurements need visual review.

For compatibility, PDF commands with neither selection flag retain their previous
combined checks. Existing `--tier visual|usability` review commands remain aliases
for inference review focus. New commands use `--tier inference --focus visual|usability`.
Legacy review JSON does not declare domains and can only be imported without an
explicit selection. New version 4 reviews declare domains and bind the prepared
bundle; imports
reject findings outside those domains. Versions 1–3 remain importable under the
limits described in the [PDF report guide](docs/pdf-report-v1.md#optional-inference-review).

## Check a PDF

```sh
pnpm check check handout.pdf --json pdf-report.json --min-image-ppi 150 --paper-size A4
```

PDFium is installed with Check. Run `node src/cli.ts setup pdf` for veraPDF and Java. Select an existing veraPDF with
`--verapdf /path/to/verapdf`, `VERAPDF`, or PATH. PDF checks run the PDF/UA-1
machine profile by default and retain detailed failed-rule/object evidence.
Use `--pdfua ua2` for PDF/UA-2, or explicitly choose `--pdfua off` for
PDFium fact checks. Direct PDF checks also collect page, font, image and text
facts without a browser. Nonembedded fonts and explicitly requested MediaBox mismatches are
findings; low-resolution images need human review under the supplied threshold.
The report identifies the exact PDF by SHA-256 and preserves raw tool evidence.
It does not certify accessibility or print quality. See [PDF report v1](docs/pdf-report-v1.md)
for coverage, coordinates, limits, and exit codes.

## Interaction review

The experimental `prepare-review` command examines recognised interactive
components. It records relevant HTML and accessibility context, performs safe
before/action/after interactions, and prepares evidence for 43 questions about
tabs, dialogs, accordions, forms, choice controls, carousels, live regions, and
focus-changing flows.

Prepare the evidence:

```bash
node src/cli.ts prepare-review /absolute/path/to/site/dist > review-evidence.md
```

For an importable review, add `--output /private/new-review`. Give the reviewer
that bundle's `review-prompt.md`, schema and evidence. Save its JSON response as
`review.json` beside `manifest.json` and `evidence.json`, then import it:

```bash
node src/cli.ts check /absolute/path/to/site/dist --tier inference --checks accessibility --review /private/new-review/review.json --json report.json
```

Changing HTML or any local asset invalidates the review. Prepare a new bundle
for the changed export. Keep bundles and report outputs outside the input folder.
The snapshot accepts regular files and directories, rejects symlinks, and has the
same 20,000-entry and 4 GiB limits as archive extraction. The retained DOM and
traces describe the earlier browser session; matching files do not establish
current network responses, dynamic state or screen-reader behavior.

The file contains course text and HTML. The evidence-only command above stays local.
Send it to a reviewer only when you are ready to share that content.
Luna at maximum reasoning effort was used
during testing. The model does not define the method, and you decide which
conclusions to accept. See [`docs/using-it.md`](docs/using-it.md) for the review
command and evidence guidance.

`prepare-review --tier inference --output ...` launches the installed Codex
CLI using your signed-in account. Use `--reviewer manual` for files to review
in another app. Codex uses Luna by default; `--model` selects another
reviewer. The optional `--classifier jev` labels captured component kinds or PDF
page-text purpose. Jev does not judge defects. Both options send evidence to the
chosen service. See [Choose a classifier and reviewer](docs/using-it.md#choose-a-classifier-and-reviewer)
for setup and limits, including [private Jev key setup](docs/using-it.md#store-and-load-your-jev-key).

## VoiceOver evidence

Windows NVDA journeys capture real keyboard delivery and speech for a sequence
of named steps against an exported folder, ZIP, or URL. Other repos call this
shared driver through `screen-reader --journey`. See [NVDA setup and integration](docs/nvda-driver.md).

A macOS-only command can capture what VoiceOver says after one named action in
Safari. With a clean comparison, the evidence can also help identify the same
phrase being announced twice. It runs locally without recording or transcribing
audio.

This command turns on VoiceOver, opens Safari, moves focus, speaks, and sends
keyboard input. It can interrupt anything else you are doing on the Mac.
Ordinary `check` and `prepare-review` runs never do this. The command refuses to
start unless you add `--take-screen-control`, and it refuses to take over a
VoiceOver session that is already running. VoiceOver testing uses your existing
Safari profile and network connection. Run it only on exports you trust.

See the [`VoiceOver instructions`](docs/using-it.md#voiceover-evidence)
and [`test results`](docs/evidence/live-region-capture-2026-08-11/README.md).

## What it works with

Praxity Check currently examines local folders and zip files that render as
static HTML in Chromium. It works best with exports that can run without an LMS
or sign-in. If a course needs files from the internet, add `--allow-network`.

Direct PDF input supports PDF/UA machine validation, font and page facts, selected
design checks, and optional visual or usability review bundles. Pass the PDF itself;
PDFs inside HTML folders or ZIPs are not scanned. See [Check a PDF](#check-a-pdf)
for the additional tools and options.

## Licence

Praxity Check by Ariel Harlap. Source-available under the PolyForm Perimeter License 1.0.1: free at home and at work, including paid client work. See [LICENSING.md](LICENSING.md).

## Build a local distributable

Use an installed development checkout and a Node distribution containing `bin/node`
and `LICENSE`:

```sh
node scripts/package.mjs --node /path/to/node-distribution --output /new/path/check
"/new/path/check/bin/praxity-check" --help
```

The artifact contains compiled Check code, Node, runtime package dependencies and
notices. It can move independently of the source checkout. This does not publish
a package. Keep the artifact on its build platform and architecture.

The package includes Node, Check, npm dependencies and PDFium. Browser, Java and
veraPDF are installed separately with `bin/praxity-check setup` after consent.
Launchers start Node and preserve explicit component variables. The old
`--dependencies` packaging option is rejected. Runtime assembly scripts have
been removed.

`capabilities.json` records package files and component requirements. Its file
hashes describe the package contents; run `doctor` to check installed components.
Test the artifact on its build platform and architecture.

For a portable build that runs on a Node runtime supplied by the host:

```sh
node scripts/package.mjs --portable --output /new/path/praxity-check
node /new/path/praxity-check/lib/cli.js --help
```

This mode includes compiled JavaScript, production dependencies, PDFium wasm,
the skill and all notices. It omits Node and launchers. `package.json` retains
the required Node range; the CLI rejects older runtimes before handling input.
`inventory.json` hashes every payload file except itself. The payload is shared
across macOS, Linux and Windows. Playwright's optional macOS test-runner watcher
is excluded, and packaging rejects native binaries. Optional components still
require consent through `node lib/cli.js setup`.

### Compare PDF engines during development

The development oracle uses native Poppler. It is excluded from the distributable.
Pass input directories and an output directory; optionally sample a local veraPDF
corpus. Put the intended native Poppler directory first on PATH, or select it
explicitly with --poppler-bin.

```sh
node scripts/pdf-engine-parity.mjs --output /path/to/diffs \
  --poppler-bin /path/to/native-tools --corpus /path/to/corpus --sample 150 \
  test/fixtures bench/pdf /path/to/extra-fixtures
```

The script writes JSON facts, word counts, print-review candidates, design spans,
render differences and a Markdown summary. Its corpus sample is deterministic.

## Check installed components

Run `node src/cli.ts doctor` to inspect the HTML browser, Java and veraPDF.
Use `doctor pdf` or `doctor html` to require only those checks, and `--json`
for the same facts as JSON. Doctor exits 0 when the selected checks have usable
components, otherwise 1. Each line records the location, version, pinned-version
match, inventory status and source. Existing bundle launcher variables count as
explicit selections. Java on PATH must be version 17 or newer.

Setup-managed components live in `%LOCALAPPDATA%/Praxity/Check/components` on
Windows, `~/Library/Application Support/Praxity Check/components` on macOS,
and `$XDG_DATA_HOME/praxity-check/components` on Linux. Linux defaults to
`~/.local/share/praxity-check/components`. `CHECK_COMPONENTS_DIR` overrides the
folder. Each component version has its own folder and file-hash inventory.
Changed, missing, extra or linked files invalidate that inventory.

## Install optional components

Run `node src/cli.ts setup` from source, or `praxity-check setup` in a standalone
package. It displays each component's purpose, version, download size, licence
and upstream URLs, then asks before installing it. Setup downloads components only after consent.
PDF facts and rendering use
bundled PDFium and need no setup. PDF/UA needs veraPDF and Java; HTML audits need
the Playwright browser. Refusing a component leaves those checks not run.

`setup --yes pdf html` consents to both check groups. You can name `browser`,
`java` or `verapdf` instead. veraPDF also selects Java for its headless installer.
An existing Java 17 or newer is reused. `setup --list` displays the same facts
without prompts, downloads or filesystem changes.

Setup exits 0 when the selected components are usable, or 1 with reasons when
the requested checks remain unavailable. `setup --list` exits 0.

For offline installation, download the archives for your target from the
[archive list](docs/offline-components.md), then run `setup --from /path/to/archives`.
Add `--yes` to consent in scripts. Offline setup never downloads missing files.
It verifies the same SHA-256 pins before extraction. Browser installation uses
Playwright's own installer with the verified archives, including FFmpeg and
Windows Winldd. Linux still needs Playwright's operating-system libraries;
install those with `pnpm exec playwright install-deps chromium` from a development
checkout or your distribution's packages.

Installations publish only after extraction, version validation and inventory
creation finish. Older versions remain beside new versions. An interrupted
install has no usable version folder. Doctor checks every file hash and detects
extra files, missing files and symlinks. If a version folder is damaged or
incomplete, move that folder outside the components directory and rerun setup.
No component download occurs during `check` or `doctor`.

Explicit `--verapdf`, `VERAPDF`, `VERAPDF_JAVA`, `VERAPDF_CLASSPATH`,
`JAVACMD`, `JAVA_HOME` and `PLAYWRIGHT_BROWSERS_PATH` retain precedence over
setup. An intact setup installation takes precedence over Java or veraPDF on
PATH. Existing Playwright developer caches remain usable and are reported as
explicit. Missing components give a setup command and incomplete coverage,
with check exit code 2.
