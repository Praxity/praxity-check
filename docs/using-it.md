# Run Praxity Check

Install once with Node 22.18+ and pnpm 11.5.3:

```bash
git clone https://github.com/Praxity/praxity-check.git
cd praxity-check
pnpm install --frozen-lockfile
node src/cli.ts setup
```

Then run it from any project. The target is a folder or zip, resolved from the
current directory:

```bash
node /absolute/path/to/praxity-check/src/cli.ts check ./dist --min-confidence medium
```

Add `--json report.json` for the complete result set. Run with `--help` for all
options.

In a standalone installation, use `praxity-check` in place of
`node /absolute/path/to/praxity-check/src/cli.ts`. Through the Praxity command,
use `praxity check`, for example `praxity check check ./dist`.
Portable builds use the host's Node with `node /path/to/check/lib/cli.js`.
The same command prefix applies to `setup`, `doctor` and `prepare-review`.

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
across audited pages are possible issues to review, not failures.

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

Each state starts from a fresh page. A player that unlocks slides in order, such as
Praxity Studio's Guided slides, sends a fresh visitor back to its first slide, so
start each state there and step forward. After each click, wait for something
unique to the next slide, such as its heading
(`.deck-slide:not([hidden]) h1:has-text("Slide title")`), rather than for the
Next button, which stays visible during the transition. A state can have up to
100 actions. Allowed actions are `click`, `waitFor`,
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

The terminal baseline comparison counts issues and possible issues at all
confidence levels. "No longer found" means absent from the current run. It does
not prove that an issue was fixed.

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

### Store and load your Jev key

You need a Jev API key only for `--classifier jev`. Codex-only reviews use your
signed-in CLI account. Your Codex subscription does not supply the Jev key.

1. Get a key from the [TypeSafe console](https://console.typesafe.ai/), as described
   in its [quick start](https://docs.typesafe.ai/introduction/quickstart).
   Check reads `JEV_API_KEY`; the TypeSafe SDK examples use `TYPESAFE_API_KEY`,
   which Check does not read.
2. Create a private file outside your repositories, checked folders, ZIP
   exports and review bundles. Avoid shared or synced folders. On macOS/Linux:

   ```bash
   mkdir -p "$HOME/.config/praxity-check"
   chmod 700 "$HOME/.config/praxity-check"
   touch "$HOME/.config/praxity-check/.env"
   chmod 600 "$HOME/.config/praxity-check/.env"
   ```

3. Open that file in a text editor. Add this line, replacing the placeholder
   with your key. Keep the quotes. Enter the key in the editor, not a shell
   command that could save it in history.

   ```dotenv
   JEV_API_KEY="replace-with-your-key"
   ```

The file is plain text, not encrypted. These permissions limit access to your
account; they do not hide it from tools running under that account. On Windows,
choose a private path outside your projects and restrict access through file
permissions to your account.

Check does **not** load `.env` automatically. Pass Node's `--env-file` flag
**before** the script path. From any folder, on macOS/Linux:

```bash
node --env-file="$HOME/.config/praxity-check/.env" \
  /absolute/path/to/praxity-check/src/cli.ts prepare-review /absolute/path/to/site/dist \
  --tier inference --output /absolute/path/to/new-review --classifier jev
```

Replace the script, target and output paths. The output directory must be new
and outside the target. For a PDF, replace the target with its PDF path. On
Windows, pass your file's absolute path to `--env-file`.

To check that Node loaded a nonempty value without printing the key:

```bash
node --env-file="$HOME/.config/praxity-check/.env" \
  -e 'console.log(process.env.JEV_API_KEY?.trim() ? "Jev key loaded" : "Jev key missing")'
```

This checks presence only; it makes no API request and does not validate the
key. A missing file produces a Node error. If the key is already set in your
shell, that value overrides the file. On macOS/Linux, run `unset JEV_API_KEY`
then retry to use the file. See [Node's env-file rules](https://nodejs.org/download/release/v22.18.0/docs/api/cli.html#--env-fileconfig).
For an HTTP 401 or 403, check the key and your account's API access in TypeSafe.

Keep the secret file out of Git, prompts, AI attachments, reports and support
messages. If you choose to store a secret file in a repository, add `.env` and
`.env.*` to that repository's `.gitignore` before saving the key. A shared
`.env.example` must contain placeholders only. Ignore rules do not remove a
secret already tracked or committed.

If a key is exposed, revoke it in TypeSafe first. Create a replacement and
update your private file and any other places that used the old key. Remove
exposed copies; if it entered Git history, coordinate history cleanup with the
repository maintainers. Deleting a file or adding an ignore rule does not revoke
a leaked key.

To stop using Jev, omit `--classifier jev` (or set `--classifier none`) and omit
`--env-file` when you no longer need it. No Jev key is needed for that run.

## VoiceOver evidence

For Windows NVDA journeys against a folder, ZIP, or URL, use
`screen-reader --journey <file.json> --output <new-directory> --take-screen-control`.
See [the shared NVDA driver guide](nvda-driver.md) for the JSON format, exit codes,
desktop setup, evidence paths, and the opt-in live test.

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
The VoiceOver command uses Guidepup 0.24.1, the version this workflow was tested
with. Guidepup 0.34 (used for NVDA) rewrites VoiceOver's preferences before each
start and fails on Macs where VoiceOver keeps a portable `.scrd.vou` folder.
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
[`live-region experiment`](evidence/live-region-capture-2026-08-11/README.md)
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

The terminal summary names the confidence threshold used for its issue count.
For example, with `--min-confidence medium`:

```text
Checked 3 pages.
2 issues found at medium confidence or higher. 1 possible issue to review.
```

Medium and low confidence findings include their confidence in each finding
group. The summary says how many lower-confidence findings it leaves out and
which `--min-confidence` option shows them. The JSON retains all findings.

Repeated notes about sampled focus checks become one line per behaviour,
counting each affected page once even when several states were checked:

```text
Note: Tested hover and focus contrast on only some controls on 3 pages; the rest were not tested. Per-page and state details: report.json
```

The JSON keeps the tested-control counts for each page and state. If you did
not save JSON, the summary tells you to add `--json <file>` for those details.

When named checks do not run, the summary puts their count immediately after
the checked-page count, even when there are no findings:

```text
Checked 3 pages.
Checks not run: 7 on 2 pages.
0 high-confidence issues found.
```

A timed-out page counts as checked because it retains completed checks. Read
the not-run count and the notes for what remains unchecked. The count includes
named checks outside the supported frame or shadow-root scope. The same check
in two rendered states counts twice; affected pages count once. Whole pages
that could not be audited and skipped declared states appear separately under
`Pages not checked` and `States not checked`.

The JSON always includes `counts.checksNotRun`, such as
`{"checks": 7, "pages": 2}`. Its `evaluations` retain each check's name, page,
state and reason. When no named checks are untested, both counts are zero and
the terminal omits the `Checks not run` line. Exit codes still depend on the
finding threshold, with `2` when no HTML page could be audited. A `0` exit does
not prove every check ran; CI can inspect these JSON counts for completeness.

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
[archive list](offline-components.md), then run `setup --from /path/to/archives`.
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
