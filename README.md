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
requirements. PDF checks use separately installed Poppler and veraPDF tools.

Status: alpha. The automated checks are ready to use. Interaction
review, PDF model review and VoiceOver evidence are experimental. In testing, a capable LLM
successfully triaged the review candidates and flagged those that needed human
review.

## Automated checks

For HTML, the `check` command scans every page and can produce findings or stop CI at
the confidence level you choose. It runs:

- axe-core's browser checks;
- keyboard traps, focus order, mouse-only controls, character shortcuts, and
  pointer-down activation;
- focus visibility, focus obscuring, and keyboard-operable scroll regions;
- text, control, graphical, hover, and focus-state contrast;
- 320-pixel reflow, text-spacing clipping, and 200% operating-system text
  scaling when a page opts in;
- contrast and focus visibility in declared dark colour schemes;
- long automatic motion and audio autoplay; and
- narrow checks for image alternatives and ambiguous link names, plus review
  questions when multiple pages reuse one title.

The pages run locally. During `check` and `prepare-review`, ordinary web requests
outside the local check server, including WebSocket connections, are blocked by
default. Only run it on packages you trust; Praxity Check is not designed to contain
deliberately malicious HTML.

The terminal summary is brief; an optional JSON report contains every finding,
question for review, and coverage note. The `--min-confidence` option controls
which findings are shown and which make the command exit with an error.

HTML, SCORM and PDF JSON reports include `feedback.schemaVersion: "feedback-1"`.
It groups findings, unresolved questions, suggestions and coverage using the same
fields. `domains` records accessibility or design independently of `method`.
Model observations retain their review category and `method: "inference"`.
`source`, `evidence` and each `provenance` entry are JSON Pointers relative to the
containing report; the original entries remain the evidence authority. Use
`source` to identify an entry within a report. An `id` can repeat across imported
reviews of the same evidence by different reviewers. Actions and confidence
appear only when the source supplies them.

Coverage keeps `untested` and `cantTell` outcomes. Its `purpose` distinguishes
extraction from checks and review. `status` describes retained validator evidence
or reviewed pages, independently of any outcome. Partial reviews list the pages
reviewed. Human review remains untested until performed. HTML review imports bind
feedback to a local content snapshot and retained browser evidence. Ordinary HTML
deterministic reports lack that revision hash. Legacy PDF reviews lack declared
domains and use an empty `domains` array with an explanation in `limitations`.

The [schema v4 guide](docs/report-schema-v4.md) documents rule outcomes,
occurrence identity, environment evidence, and migration from v3.

## Quick start

Requirements: Node 22.18+ and pnpm 11.5.3.

```bash
git clone https://github.com/Praxity/praxity-check.git
cd praxity-check
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
node src/cli.ts check /absolute/path/to/site/dist --min-confidence medium
```

For HTML checks, the target may be a folder or zip. Add `--json report.json` to save the full
results and `--baseline previous-report.json` to compare exact occurrences with
a reviewed prior report. Use `--scenarios check-scenarios.json` to scan states revealed by safe
click, key, selection, and wait actions. The [usage guide](docs/using-it.md#named-rendered-states)
documents the JSON format. Run `node src/cli.ts --help` to see every option.

Reports and evidence files can contain course content, local paths, requested
URLs, and VoiceOver speech. Review them before sharing.

The command exits with `0` when it finds no problems at the selected confidence
level, `1` when it finds problems, and `2` when the check cannot run. Questions
that need human judgement appear under `needsReview` in the JSON report. They
do not change the exit code.

## Select checks and evidence

`--checks accessibility|design|accessibility,design` selects what to assess.
`--tier deterministic|inference` selects how evidence is assessed, consistently
across HTML folders, SCORM ZIPs and PDFs. Canonical commands default to
accessibility; add design explicitly. Deterministic checks use fixed rules and
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
`--design-evidence` adds Poppler text measurements and detail crops to design review
bundles. Optional `--min-text-size-pt 10` states a requirement for all extracted
text; it is not a universal readability threshold. Measurements need visual review.

For compatibility, PDF commands with neither selection flag retain their previous
combined checks. Existing `--tier visual|usability` review commands remain aliases
for inference review focus. New commands use `--tier inference --focus visual|usability`.
Legacy review JSON does not declare domains and can only be imported without an
explicit selection. New version 3 reviews declare domains; imports reject findings
outside them. Existing version 1 and 2 files remain valid for legacy combined runs.

## Check a PDF

```sh
pnpm check check handout.pdf --json pdf-report.json --min-image-ppi 150 --paper-size A4
```

Install Poppler and veraPDF with its Java runtime separately. `pdfinfo`,
`pdffonts`, `pdfimages`, and `pdftotext` should be on PATH. Select veraPDF with
`--verapdf /path/to/verapdf`, `VERAPDF`, or PATH. PDF checks run the PDF/UA-1
machine profile by default and retain detailed failed-rule/object evidence.
Use `--pdfua ua2` for PDF/UA-2, or explicitly choose `--pdfua off` for
Poppler-only checks. Direct PDF checks also collect page, font, image and text
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

The file contains course text and HTML. Nothing leaves your computer until you
choose to send it to a reviewer. Luna at maximum reasoning effort was used
during testing. The model does not define the method, and you decide which
conclusions to accept. See [`docs/using-it.md`](docs/using-it.md) for the review
command and evidence guidance.

## VoiceOver evidence

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
and [`test results`](docs/experiments/live-region-capture-2026-08-11/README.md).

## What it works with

Praxity Check currently examines local folders and zip files that render as
static HTML in Chromium. It works best with exports that can run without an LMS
or sign-in. If a course needs files from the internet, add `--allow-network`.

Direct PDF input supports PDF/UA machine validation, font and page facts, selected
design checks, and optional visual or usability review bundles. Pass the PDF itself;
PDFs inside HTML folders or ZIPs are not scanned. See [Check a PDF](#check-a-pdf)
for the additional tools and options.

## Licence

Praxity Check is community source. Personal, educational, nonprofit,
governmental, and internal organizational use is permitted. This includes using
it internally to check paid work. Qualifying free public forks and services must
display the required credit, publish their Praxity Check source and changes under the
same terms, and preserve attribution in reports. Paid access or reports,
substantially Praxity Check-powered paid services, paid hosting, repackaging, and
white-labelling require separate written permission.

See [`LICENSE`](LICENSE) for the terms and [`LICENSING.md`](LICENSING.md) for
plain-language examples.

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

Optional `--dependencies /path/to/reviewed-runtimes` copies that directory into the
artifact. It must include `NOTICE.md`; retain all applicable dependency notices.
Use `bin/` for Poppler tools and the veraPDF launcher, `java/` for a Java runtime,
and `browsers/` for Playwright's matching browser installation. Native shared
libraries must also be relocatable. Homebrew executables alone are not sufficient.
The package launcher sets these paths without downloading tools.

`capabilities.json` records requirements, not successful capability tests. Without
the required runtimes, PDF checks report incomplete evidence and HTML checks report
the missing browser. PDF and HTML need different runtimes; test the operations you
intend to distribute from a fresh directory without development tools on PATH.

Rubato can stage this prebuilt artifact with `stage-rubato-tools.mjs --check`. Check
implementation remains in this repository; Rubato only copies the artifact and
provides a launcher. Desktop-local tools are not installed in remote environments.

### Prepare macOS arm64 runtimes

The native preparation scripts use Xcode command-line tools and installed Homebrew
build dependencies. Keep their work directories outside this repository.
`build-poppler-runtime.mjs` requires CMake, downloads hash-pinned official Poppler
source and character maps, and retains its source patch and build recipe.

```sh
node scripts/build-poppler-runtime.mjs --work "$CHECK_BUILD" --cmake /path/to/cmake
node scripts/prepare-poppler.mjs --source-install "$CHECK_BUILD/poppler-install" \
  --supplemental-notices "$CHECK_BUILD/supplemental-notices" --output "$CHECK_BUILD/poppler-runtime"
node scripts/test-poppler-data.mjs "$CHECK_BUILD/poppler-runtime"
node scripts/prepare-runtimes.mjs --poppler "$CHECK_BUILD/poppler-runtime" \
  --verapdf /path/to/verapdf --java /path/to/jdk-home --browsers /path/to/playwright-cache \
  --supplemental-notices "$CHECK_BUILD/supplemental-notices" --output "$CHECK_BUILD/dependencies"
node scripts/package.mjs --node /path/to/node-distribution \
  --dependencies "$CHECK_BUILD/dependencies" --output "$CHECK_BUILD/check"
```

Each output directory must be new. Native preparation copies and rewrites Mach-O
load paths, then ad-hoc signs copied binaries. It never modifies installed tools.
Missing licenses, unresolved libraries, filename collisions and conflicting runtime
versions stop preparation. When an installed dependency lacks its license text,
supply the original text and provenance under `supplemental-notices/<package>/`.
veraPDF input must contain its project license files as well as its installed jars.

The source-built Poppler reads its packaged character maps through
`POPPLER_DATADIR`. The Check launcher selects the bundled font configuration, which
uses macOS system fonts and a user cache. This supports unembedded-font substitution
without Homebrew font configuration. It does not make fonts identical across macOS
versions. `test-poppler-data.mjs` checks Japanese CID text, a missing-data control,
font substitution and a raster with Homebrew access blocked.

Runtime assembly checks the installed Playwright metadata and copies its matching
Chromium headless shell. It supplies headless Check operations; it does not include
a general browser UI. Java native libraries are relocated too. Revalidate actual
PDF and HTML operations when changing any runtime version.

These scripts prepare local prototype artifacts. Clean-machine and older-macOS
compatibility, distribution source obligations, Developer ID signing and notarization
remain separate release work.
