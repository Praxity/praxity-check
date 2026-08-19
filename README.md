# Praxity Accessibility Audit

Find accessibility issues in eLearning exports and interactive websites
before they reach learners.

## Why use it

eLearning exports from authoring tools and interactive websites created with
generative AI can contain accessibility barriers. Focus can disappear, menus
can trap keyboard users, colour contrast can fail when someone hovers over an
interactive element, and page updates can go unannounced. Checking your HTML
exports helps you find issues early, before they create barriers for learners.

Run Praxity Accessibility Audit when evaluating eLearning authoring tools or during iterative
development of an online course. It locates and describes likely accessibility
issues in your HTML so you can review them and decide what to fix. On macOS, it
can also use VoiceOver to test specific interactions one at a time and capture
what was announced.

## What it is

Praxity Accessibility Audit is a local command-line tool. Give it a folder or zip file and it
checks every HTML page inside.

Status: alpha. The automated checks are ready to use. Interaction
review and VoiceOver evidence are experimental. In testing, a capable LLM
successfully triaged the review candidates and flagged those that needed human
review.

## Automated checks

The `check` command scans every HTML page and can produce findings or stop CI at
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
outside the local audit server, including WebSocket connections, are blocked by
default. Only audit packages you trust; Praxity Accessibility Audit is not designed to contain
deliberately malicious HTML.

The terminal summary is brief; an optional JSON report contains every finding,
question for review, and coverage note. The `--min-confidence` option controls
which findings are shown and which make the command exit with an error.

## Quick start

Requirements: Node 22.18+ and pnpm 11.5.3.

```bash
git clone https://github.com/Praxity/praxity-audit.git
cd praxity-audit
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
node src/cli.ts check /absolute/path/to/site/dist --min-confidence medium
```

The target may be a folder or zip. Add `--json report.json` to save the full
results. Run `node src/cli.ts --help` to see every option.

Reports and evidence files can contain course content, local paths, requested
URLs, and VoiceOver speech. Review them before sharing.

The command exits with `0` when it finds no problems at the selected confidence
level, `1` when it finds problems, and `2` when the audit cannot run. Questions
that need human judgement appear under `needsReview` in the JSON report. They
do not change the exit code.

## Interaction review

The experimental `prepare-review` command examines recognised interactive
components. It records relevant HTML and accessibility context, performs safe
before/action/after interactions, and prepares evidence for 37 questions about
tabs, dialogs, accordions, forms, choice controls, carousels, live regions, and
focus-changing flows.

Prepare the evidence:

```bash
node src/cli.ts prepare-review /absolute/path/to/site/dist > review-evidence.md
```

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

Praxity Accessibility Audit currently checks local folders and zip files that render as
static HTML in Chromium. It works best with exports that can run without an LMS
or sign-in. If a course needs files from the internet, add `--allow-network`.

## Licence

Praxity Accessibility Audit is community source. Personal, educational, nonprofit,
governmental, and internal organizational use is permitted. This includes using
it internally to check paid work. Qualifying free public forks and services must
display the required credit, publish their Accessibility Audit source and changes under the
same terms, and preserve attribution in reports. Paid access or reports,
substantially Accessibility Audit-powered paid services, paid hosting, repackaging, and
white-labelling require separate written permission.

See [`LICENSE`](LICENSE) for the terms and [`LICENSING.md`](LICENSING.md) for
plain-language examples.
