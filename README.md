# Praxity Audit

Find accessibility problems in eLearning exports and interactive websites
before they reach learners.

## Why use it

Some accessibility problems only appear once a course is running. Focus can
disappear, menus can trap keyboard users, colours can fail when someone hovers,
and page updates can go unannounced. Checking the finished export helps you find
problems in the experience learners will actually use.

Run Praxity Audit while developing a course and again before release,
especially after exporting from an authoring tool. It points to the affected
page and control so you can fix problems while the work is still fresh. Use it
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

Tier B prepares a local evidence file for a separate Luna-Max review. You
choose whether to send it and which results to accept.

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
choose to send it to Luna-Max. See [`docs/using-it.md`](docs/using-it.md) for
the review command, the 37 checks, and guidance on useful evidence.

## What it works with

Praxity Audit currently checks local folders and zip files that render as
static HTML in Chromium. It works best with exports that can run without an LMS
or sign-in. Test LMS-only behaviour, signed-in pages, and screen-reader output
separately. If a course needs files from the internet, add `--allow-network`.

## Licence

Praxity Audit is community source. Personal, educational, nonprofit,
governmental, and internal organizational use is free. This includes using it
to check paid work while you develop it. Free public forks and services must
credit Praxity Audit and publish their Audit source and changes. Paid audit
services, hosting, repackaging, and white-labelling require separate permission.

See [`LICENSE`](LICENSE) for the terms and [`LICENSING.md`](LICENSING.md) for
plain-language examples.
