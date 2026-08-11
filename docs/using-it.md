# Running Praxity Audit

Install once with Node 22.18+ and pnpm 11.5.3:

```bash
git clone https://github.com/Praxity/praxity-audit.git
cd praxity-audit
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Then run it from any project. The target is a folder or zip, resolved from the
current directory:

```bash
node /absolute/path/to/praxity-audit/src/cli.ts check ./dist --min-confidence medium
```

Add `--json report.json` for the complete result set. Run with `--help` for all
options.

## Confidence threshold

`--min-confidence high|medium|low` (default `high`) controls both what the
summary prints and what sets the exit code.

| Level | What it gates on | Use when |
|---|---|---|
| `high` | Measured, unambiguous failures — mostly axe, plus narrow observed checks such as long audio autoplay | You want a quiet gate that only stops on things nobody would argue with |
| `medium` | Adds the custom checks — focus/state contrast, keyboard scrolling, focus obscuring, non-text contrast, reflow and text spacing | **You want what this tool sees that axe does not.** Most of the custom layer is medium by construction |
| `low` | Adds axe best-practice advice — landmarks, heading order | Exhaustive review, not a gate |

**`medium` is the interesting setting.** The focus, contrast-state, scrolling
and layout checks sit at medium because W3C specifies rendered outcomes and
these probes are conservative proxies. Audio autoplay reaches high only after
the browser observes more than three seconds of unmuted playback without a
control.

Exit codes: `0` nothing at or above the threshold, `1` findings present, `2`
could not run.

## Tiers and evidence methods

Tiers classify the conclusion:

| Tier | Question | Use |
|---|---|---|
| A | Is there a deterministic failure without guessing component or author intent? | Local CLI; may gate by confidence |
| B | Does a recognised component behave correctly through a named interaction? | Independent review; human-approved |
| C | Is the content, structure or UX appropriate in context? | Advisory evidence only |

Record how the evidence was obtained separately: `rendered`, `interaction`,
`screen-reader`, or `source`. Browser tracing is not automatically Tier B —
Tier A already uses browser interactions. Source can explain a reproduced bug,
but source alone does not prove runtime behaviour.

## Tier B: recognised-pattern interaction review

Tier B remains a separate, human-approved LLM review. Luna at maximum reasoning
effort was used during testing, but the model is not part of the tier's
definition. The experimental packet command uses the same local,
network-blocked browser boundary as Tier A and writes bounded rendered DOM,
accessibility snapshots, and generic before/action/after traces:

```bash
node /absolute/path/to/praxity-audit/src/cli.ts prepare-tier-b ./dist > tier-b-evidence.md
```

The command does not run Tier A, invoke a model, upload anything, or decide that
a trace is a defect. It records only recognised candidates and reversible
generic actions; the packet names missing components, unsafe or unknown
triggers, and other unexercised rules. Review the Markdown before sending it
anywhere because it contains course text and markup.

Append the packet to the prompt and run the LLM reviewer read-only from the
Audit repo, not from the target. The reviewer needs the evidence, not source
access. This example uses Luna at maximum reasoning effort:

```bash
{
  cat /absolute/path/to/praxity-audit/docs/tier-b-prompt.md
  printf '\n\n# Prepared evidence packet\n'
  cat /absolute/path/to/tier-b-evidence.md
} | codex -a never exec --ephemeral \
  -C /absolute/path/to/praxity-audit -s read-only \
  -m gpt-5.6-luna -c 'model_reasoning_effort="max"' \
  -o /absolute/path/to/tier-b.md -
```

This uses the official
[`codex exec`](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-exec)
non-interactive command. `--ephemeral` avoids saving a local Codex session
rollout; it does not prevent the chosen model service from receiving the packet.

Run Tier A separately. Do not give its report to Tier B; merge and deduplicate
the results only after both runs complete. If no browser or prepared trace was
available, runtime claims remain suspected even when markup looks suspicious.

After approving a finding, trace its cause separately in the developer project
using the packet's page, selector, IDs, classes, and text. That follow-up may
inspect the smallest relevant source slice; the Tier B reviewer may not search
the package or a minified bundle.

`prepare-tier-b` exits `0` when it prepared at least one page and `2` when it
could not prepare any. It never exits `1`: evidence is not a finding and cannot
gate CI.

## Screen-reader evidence

Use screen-reader evidence for one named action whose open question is what was
announced. Record the exact pairing and versions, such as VoiceOver + Safari or
NVDA + Chromium.

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

Heading-level appropriateness and similar authored-content questions remain
Tier C. A screen reader can repeat the level but cannot determine author intent.

## As an agent hook

Paste into a repo's `AGENTS.md`:

```markdown
## Accessibility check

After changing anything that affects rendered output — components, styles,
design tokens, navigation, templates — build, then run:

    node /absolute/path/to/praxity-audit/src/cli.ts check ./dist --min-confidence medium

Fix what it reports, rerun, and repeat until it is clean or the remaining
findings are ones you can justify leaving. Read the caveats below before
deciding a finding is wrong.

- **Silence is not a pass.** Known clean and broken controls exercise each
  custom check, but recall is unproven. "No findings" does not mean "accessible".
- **Deduplicate before fixing.** Many findings can come from one shared token or
  component. Group by rule and by the colour pair or selector shape in the
  evidence.
- **It starts from the initial rendered state.** It exercises hover and focus on
  initial controls, but anything behind a click, route, or closed component is
  invisible to it.
- **It reports its own blind spots.** If a note says custom checks examined only
  the light DOM, controls inside an iframe or shadow root were not checked.
- Medium confidence means the check is a proxy for a rendered outcome, not that
  the finding is probably wrong.
```

## Reading the output

Findings state what is wrong, where it was found, and the standards or guidance
behind it. They do not infer which people are affected. Locators are real CSS
selectors — `div:nth-of-type(3) > span` — and the accessible name is in the
evidence.

The human summary is budgeted; **the JSON is complete**. If the summary says
findings were withheld, they are all in the `--json` file.

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
