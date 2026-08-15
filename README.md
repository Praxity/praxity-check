# Praxity Audit

Find accessibility problems in eLearning exports and interactive websites
before they reach learners.

## Why use it

Some accessibility problems only appear once a course is running. Focus can
disappear, menus can trap keyboard users, colours can fail when someone hovers,
and page updates can go unannounced. Checking the finished export helps you find
problems in what learners will actually use.

Run Praxity Audit when evaluating eLearning authoring tools or during iterative
development of an online course. It locates and details accessibility gaps in
your HTML so you can review them and decide what to fix. Ideally, use it
alongside keyboard and screen-reader testing for a fuller review.

## What it is

Praxity Audit is a local command-line tool. Give it a folder or zip file and it
checks every HTML page inside.

Status: pre-release alpha. Tier A is ready to try. Tier B is experimental. When
a check needs human judgement, the report asks for review instead of calling it
a problem.

## What it checks

- scans every HTML page in a folder or zip;
- runs axe-core and browser checks for keyboard use, focus, colour contrast,
  small-screen layout, text spacing, motion, and audio that starts automatically;
- runs pages locally and blocks their internet requests by default;
- gives you a short terminal summary and a detailed JSON report; and
- prepares optional evidence for reviewing common interactive controls.

Tier A runs repeatable browser checks. The `--min-confidence` option controls
which findings make the command exit with an error.

Tier B prepares a local evidence file for a separate LLM review. Luna at maximum
reasoning effort was used during testing. You choose whether to send the file
and which results to accept.

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

The command exits with `0` when it finds no problems at the selected confidence
level, `1` when it finds problems, and `2` when the audit cannot run. Questions
that need human judgement appear under `needsReview` in the JSON report. They
do not change the exit code.

## Tier B review

Prepare a local evidence file:

```bash
node src/cli.ts prepare-tier-b /absolute/path/to/site/dist > tier-b-evidence.md
```

The file contains course text and HTML. Nothing leaves your computer until you
choose to send it to an LLM reviewer. See [`docs/using-it.md`](docs/using-it.md) for
the review command, the 37 checks, and guidance on useful evidence.

## Experimental screen-reader checks

A macOS-only command can capture what VoiceOver says after one named action in
Safari. With a clean comparison, the evidence can also help identify the same
phrase being announced twice. It runs locally without recording or transcribing
audio.

This command turns on VoiceOver, opens Safari, moves focus, speaks, and sends
keyboard input. It can interrupt anything else you are doing on the Mac.
Ordinary `check` and `prepare-tier-b` runs never do this. The command refuses to
start unless you add `--take-screen-control`, and it refuses to take over a
VoiceOver session that is already running.

See the [`screen-reader instructions`](docs/using-it.md#screen-reader-evidence)
and [`test results`](docs/experiments/live-region-capture-2026-08-11/README.md).

## What it works with

Praxity Audit currently checks local folders and zip files that render as
static HTML in Chromium. It works best with exports that can run without an LMS
or sign-in. Test LMS-only behaviour, signed-in pages, and screen-reader output
separately. If a course needs files from the internet, add `--allow-network`.

## Roadmap

The next experiment will build a short, guided course walk from this one-action
check: skip-link entry, page order, hidden or unreachable content, and gated or
branching activities. It will remain opt-in because it takes over VoiceOver and
keyboard focus while it runs.

## Licence

Praxity Audit is community source. Personal, educational, nonprofit,
governmental, and internal organizational use is permitted. This includes using
it internally to check paid work. Qualifying free public forks and services must
display the required credit, publish their Audit source and changes under the
same terms, and preserve attribution in reports. Paid access or reports,
substantially Audit-powered paid services, paid hosting, repackaging, and
white-labelling require separate written permission.

See [`LICENSE`](LICENSE) for the terms and [`LICENSING.md`](LICENSING.md) for
plain-language examples.
