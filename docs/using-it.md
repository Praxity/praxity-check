# Run Praxity Check

Install once with Node 22.18+ and pnpm 11.5.3:

```bash
git clone https://github.com/Praxity/praxity-check.git
cd praxity-check
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Then run it from any project. The target is a folder or zip, resolved from the
current directory:

```bash
node /absolute/path/to/praxity-check/src/cli.ts check ./dist --min-confidence medium
```

Add `--json report.json` for the complete result set. Run with `--help` for all
options.

During `check` and `prepare-review`, ordinary web requests outside the local
check server, including WebSocket connections, are blocked by default. Only
run it on packages you trust; Praxity Check is not designed to contain deliberately
malicious HTML.

## Confidence threshold

`--min-confidence high|medium|low` (default `high`) controls both what the
summary prints and what sets the exit code.

| Level | What it gates on | Use when |
|---|---|---|
| `high` | Axe failures and narrow measured checks, including long audio autoplay | Start with the highest-confidence findings |
| `medium` | Also includes focus, contrast, scrolling and layout probes | Review the custom checks alongside axe results |
| `low` | Also includes best-practice advice, such as landmarks and heading order | Include advice in your review |

Use `medium` to include focus, contrast-state, scrolling and layout checks.
These probes approximate rendered outcomes and need review. Audio autoplay
reaches high only after
the browser observes more than three seconds of unmuted playback without a
control.

When a page opts into `<meta name="text-scale" content="scale">`, Praxity Check tests
the 320-pixel presentation at 200% operating-system text scale. It also reruns
visual checks when the document declares a dark colour scheme. Repeated titles
across audited pages are questions for review, not automatic failures.

Exit codes: `0` nothing at or above the threshold, `1` findings present, `2`
could not run.

## Named rendered states

A launcher page or closed component can hide most of a course from the initial
scan. Declare the states that matter in a JSON file:

```json
{
  "scenarios": [
    {
      "id": "lesson-open",
      "page": "index.html",
      "actions": [
        { "action": "click", "selector": "button#start" },
        { "action": "waitFor", "selector": "main.lesson" }
      ]
    }
  ]
}
```

Run the initial scan and each declared state:

```bash
node /absolute/path/to/praxity-check/src/cli.ts check ./dist \
  --scenarios ./check-scenarios.json \
  --json report.json
```

Each state starts from a fresh page. Allowed actions are `click`, `waitFor`,
`select` with a `value`, and `press` with one navigation key such as `Enter`,
`Space`, `Tab`, `Escape`, or an arrow key. The file cannot execute JavaScript.
Failed actions appear as `untested` evaluations instead of clean results. The
report retains the scenario IDs and actions needed to reproduce the run.

## Baselines and review decisions

Save a complete schema-v4 report, review its occurrences, then use that report
as an exact baseline:

```bash
node /absolute/path/to/praxity-check/src/cli.ts check ./dist \
  --baseline ./reviewed-baseline.json \
  --json ./current-report.json
```

Without a baseline, each finding and review question has `disposition:
"unreviewed"` and no `comparison`. With a baseline, current occurrences are
`new` or `existing`, and prior occurrences no longer present appear under
`changes.resolved`.

To review an occurrence in the baseline, keep it in its original array and add
an accountable decision:

```json
{
  "disposition": "accepted",
  "review": {
    "reason": "Legacy player replacement is scheduled for Q4",
    "owner": "Accessibility lead",
    "reviewedAt": "2026-08-29"
  }
}
```

`falsePositive` uses the same metadata. Praxity Check rejects reviewed decisions
without a reason, owner, or valid `YYYY-MM-DD` date. A matching decision carries
forward only for the same occurrence and result collection; a second target
with the same rule is new and unreviewed. Decisions stay visible and do not
rewrite `failed` or `cantTell` outcomes, remove findings, or change the CLI exit
threshold.

Use an unmodified report as the starting baseline rather than constructing IDs
by hand. Occurrence identity is rule + page + selector + state; evidence wording
is deliberately excluded so clearer excerpts do not create fake regressions.

## Praxity Check workflows and evidence

Automated checks produce repeatable findings and may stop CI at the confidence
level you select. Interaction review examines recognised components through
prepared before/action/after evidence; its conclusions require human approval
and never stop CI.

The evidence may be `rendered`, `interaction`, `screen-reader`, or `source`.
Browser tracing is not automatically a review item because the automated checks
also interact with pages. Source can explain a reproduced bug, but source alone
does not prove runtime behaviour.

## Interaction review

Interaction review remains a separate, human-approved LLM review. Luna at
maximum reasoning effort was used during testing, but the model does not define
the method. The experimental packet command uses the same local browser boundary
as the automated checks and writes bounded rendered DOM, accessibility
snapshots, and generic before/action/after traces:

```bash
node /absolute/path/to/praxity-check/src/cli.ts prepare-review ./dist > review-evidence.md
```

With the default options, the command collects evidence locally without running
automated checks or calling a model. It records only recognised candidates and
reversible generic actions; the packet names missing components, unsafe or
unknown triggers, and other unexercised rules. Review the Markdown before
sending it anywhere because it contains course text and markup.

Append the packet to the prompt and run the LLM reviewer read-only from the
Praxity Check repo, not from the target. The reviewer needs the evidence, not source
access. This example uses Luna at maximum reasoning effort:

```bash
{
  cat /absolute/path/to/praxity-check/docs/review-prompt.md
  printf '\n\n# Prepared evidence packet\n'
  cat /absolute/path/to/review-evidence.md
} | codex -a never exec --ephemeral \
  -C /absolute/path/to/praxity-check -s read-only \
  -m gpt-5.6-luna -c 'model_reasoning_effort="max"' \
  -o /absolute/path/to/review.md -
```

This uses the official
[`codex exec`](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-exec)
non-interactive command. `--ephemeral` avoids saving a local Codex session
rollout; it does not prevent the chosen model service from receiving the packet.

Run the automated checks separately. Do not give their report to the interaction
reviewer; merge and deduplicate the results only after both runs complete. If no
browser or prepared trace was available, runtime claims remain suspected even
when markup looks suspicious.

After approving a finding, trace its cause separately in the developer project
using the packet's page, selector, IDs, classes, and text. That follow-up may
inspect the smallest relevant source slice; the reviewer may not search the
package or a minified bundle.

With the default options, `prepare-review` exits `0` when it prepared at least
one page and `2` when it could not prepare any. It never exits `1`: evidence is not a finding and cannot
gate CI.

### Import a review into a report

Create a new bundle directory outside the checked folder:

```bash
node /absolute/path/to/praxity-check/src/cli.ts prepare-review ./dist \
  --output /private/new-review --reviewer manual
```

Give your reviewer the bundle's `review-prompt.md`, `review.schema.json` and
retained evidence. This prompt requests JSON; the Markdown prompt above requests
a written review. Save the JSON response as `review.json` beside `manifest.json`
and `evidence.json`, then import it:

```bash
node /absolute/path/to/praxity-check/src/cli.ts check ./dist \
  --tier inference --checks accessibility \
  --review /private/new-review/review.json --json report.json
```

The import verifies the local files and retained evidence. It does not run a
browser or repeat the automated checks. Omit `--tier inference` to run those
checks alongside the imported review. Only automated findings affect the failure
exit code; model observations remain separate.

After changing any HTML or local asset, prepare and review a new bundle.
Keep report outputs outside the checked folder so they do not change its snapshot.
A valid import binds files to evidence; it does not prove that the reviewer
inspected that evidence or reached the right conclusion.

### Choose a classifier and reviewer

`prepare-review --tier inference` launches the installed Codex CLI by default.
Sign in with your subscription first. Luna reviews the evidence automatically.
Use `--reviewer manual` to prepare files for your preferred AI app instead.
Older HTML commands without `--tier inference` and legacy PDF `visual` or
`usability` tiers still prepare manual evidence unless you select a reviewer.
The reviewer judges the evidence; you decide which proposed changes to accept.

| Option | Default | What it does |
| --- | --- | --- |
| `--classifier none\|jev` | `none` | Optionally asks Jev to label retained content. |
| `--reviewer manual\|codex` | `codex` with `--tier inference`; otherwise `manual` | Leaves the bundle for you, or runs Codex to write a JSON review. |
| `--model <id>` | `gpt-5.6-luna` | Selects the Codex reviewer model. Requires Codex review. |

For HTML, automatic review and optional Jev classification require `--output`. Use a new directory
outside the checked folder. PDF preparation can create its own temporary bundle.

```bash
node /absolute/path/to/praxity-check/src/cli.ts prepare-review ./dist \
  --tier inference --output /private/new-review
```

Codex must be installed and signed in. It runs read-only with an ephemeral
session. The default Luna reviewer uses maximum reasoning effort. A custom
model uses its CLI default. Check validates the response against the bundle
before saving
`review.json`. Import that file with the command above. An ephemeral session
still sends evidence to the model service. If the review fails, Check exits
with `2` and keeps the bundle for inspection. It saves `review.json` only after
validation succeeds.

To use Jev, set `JEV_API_KEY` in your environment and add `--classifier jev`.
This sends retained HTML component slices or extracted PDF page text to the
Jev API, even if the reviewer is manual. PDF text is capped at 10,000 characters
per page. Jev receives no page images; the Codex reviewer receives the selected
PDF images.
The classifier uses the pinned `jev-1.13.0` model; `--model` changes only the
Codex reviewer.

Jev is an optional classifier. For HTML, it labels the kind of component among
candidates Check already captured. For PDFs, it labels the purpose of extracted
page text. These labels do not discover new components, inspect PDF images or
establish whether evidence is sufficient. Jev does not decide whether a defect
exists or a task succeeded. Keep those decisions with Luna or your chosen reviewer.

Classification retains its model, confidence and source evidence in
`classifier.json`, beside the unchanged browser or PDF evidence.
`classifier-attempts.jsonl` keeps completed requests and service errors, including
when classification stops before it can finish. Empty or truncated text is
marked unknown without a request to Jev.
`review-run.json` records the selected services and hashes. A Codex run also
keeps its raw response in `review-response.txt` and its log in `reviewer.log`.
Treat classification as advice. A high confidence score is not an accessibility verdict.

Neither workflow requires BAML.

## VoiceOver evidence

Use screen-reader evidence for one named action whose open question is what was
announced. Record the exact pairing and versions, such as VoiceOver + Safari or
NVDA + Chromium.

On macOS, run the experimental VoiceOver + Safari command only when the computer
is free for it to take over:

```bash
node /absolute/path/to/praxity-check/src/cli.ts screen-reader ./dist \
  --page lesson.html \
  --control "Show definition" \
  --expected "Definition" \
  --take-screen-control \
  --allow-network > screen-reader-evidence.md
```

The command turns on VoiceOver, opens its own Safari window, moves focus while
it looks for the named control, and presses Space. It closes that window,
stops the VoiceOver session it started, and returns to the previously active
app. It refuses to run if VoiceOver is already on. `check` and `prepare-review`
never start VoiceOver.

Real Safari cannot use the network block applied to the Chromium checks, so the
command also requires `--allow-network`. Review the package first: scripts in
the page may make their usual internet requests. It uses your existing Safari
profile and network connection, so run it only on exports you trust. The page
itself must still be an HTML file inside the audited folder or zip.

Guidepup requires one-time macOS permissions before it can control VoiceOver.
Follow its [manual VoiceOver setup](https://www.guidepup.dev/docs/guides/manual-voiceover-setup).
The command produces evidence, not a finding, and never changes the automated
check exit code.

The tested VoiceOver + Safari workflow reads VoiceOver's last phrase directly.
For suspected duplicate speech, it also counts local speech starts during the
action and compares them with a clean version that announces the phrase once.
The control produced one speech start for every clean run and two for every
duplicate run across three pairs. It records no audio and uses no transcription.

Keep the clean comparison. A speech start does not contain the phrase itself and
can come from unrelated VoiceOver output, so an unbounded count or the presence
of two possible announcement channels is not enough. See the
[`live-region experiment`](experiments/live-region-capture-2026-08-11/README.md)
for the method, controls, and recorded results.

Run the same command against a clean version that announces the expected phrase
once. Compare the two Markdown files. More speech-event clusters in the
suspected version are a signal for review, not proof by themselves.

## As an agent hook

Paste into a repo's `AGENTS.md`:

```markdown
## Accessibility check

After changing components, styles, design tokens, navigation or templates,
build the project, then run:

    node /absolute/path/to/praxity-check/src/cli.ts check ./dist --min-confidence medium

Fix what it reports, rerun, and repeat until it is clean or the remaining
findings are ones you can justify leaving. Read the caveats below before
deciding a finding is wrong.

- **Silence is not a pass.** Known clean and broken controls exercise each
  custom check, but recall is unproven. "No findings" does not mean "accessible".
- **Deduplicate before fixing.** Many findings can come from one shared token or
  component. Group by rule and by the colour pair or selector shape in the
  evidence.
- The default scan starts from the initial rendered state and exercises hover
  and focus. Add `--scenarios` to check named states behind clicks or closed
  components. States you do not declare can remain untested.
- **It reports its own blind spots.** If a note says custom checks examined only
  the light DOM, controls inside an iframe or shadow root were not checked.
- Medium confidence means the check is a proxy for a rendered outcome, not that
  the finding is probably wrong.
```

## Reading the output

Findings state what is wrong, where it was found, and the standards or guidance
behind it. They do not infer which people are affected. Locators are real CSS
selectors such as `div:nth-of-type(3) > span`. The evidence includes the
accessible name.

The terminal summary has a length limit. The JSON retains all results. If the
summary says
findings were withheld, they are all in the `--json` file.

Reports and evidence files can contain course content, local paths, requested
URLs, and VoiceOver speech. Review them before sharing.

Unresolved automatic evidence appears separately in `needsReview`. These items
retain their selector and reason but are not violations and never affect the
exit code, regardless of `--min-confidence`.

## When a finding looks wrong

It has been wrong before. If one looks wrong:

1. Check the WCAG exception first. Most past false positives were a check
   applying a criterion outside its scope: user-agent-sized controls are exempt
   from 2.5.8, link purpose can come from context under 2.4.4, screen-reader-only
   text is meant to overflow its box.
2. Reproduce the measured state in the browser before changing product code.
3. Report it with the smallest shareable reproducer. Never attach private
   customer content to a public issue.
