# Interaction-review controls

The tab files use the same recognised component markup with three behaviours:
missing arrow operation, automatic activation, and W3C-style manual activation.
A useful review packet must expose those differences in before/action/after
traces without declaring any result a finding itself.

The native-select control verifies that the packet labels native popup and
keyboard behaviour unexercised instead of treating headless-browser silence as
a product failure.

The state/context control verifies that each trace-bearing candidate is reset
before later evidence is captured, and that a disclosure packet includes its
heading ancestor rather than only the button fragment.

## Development review corpus, version 1

`node bench/interaction-review/materialize.mjs /absolute/new/corpus` writes 16
isolated HTML inputs and a separate `private-key.json`. The destination must be
new and outside this repository. The key records source and input hashes, tasks,
expected defects and control judgments. Each input directory contains only
`index.html`. Diagnostic source titles become neutral lesson titles. The source
manifest and materializer also receive hashes.

These are development cases. Their mechanisms and keys have been inspected while
building the collector and importer. They cannot become held-out cases by changing
names, wording, trial order or models. Freeze a separate fresh corpus for claims
about model generalization. Leave existing PDF comparisons, generators, scores and
cost records unchanged.

| Family | Cases | Planted defects | Task controls |
| --- | ---: | ---: | ---: |
| Tabs | 3 | 1 | 2 |
| Native choice | 1 | 0 | 1 |
| Disclosure | 4 | 2 | 2 |
| Stateful checkbox | 4 | 2 | 2 |
| Dialogs | 4 | 2 | 2 |

Controls establish the stated task only. The native select case tests whether a
reviewer respects missing evidence; its unexercised native popup is not a proven
pass. Related pairs share markup and mechanisms. Seven planted defects remain a
small denominator, and each family needs its own reported counts.

Before model calls, prepare each isolated directory through the production HTML
inference path. Inspect its DOM and action traces against the key. Confirm that
every planted behavior is visible in the evidence the reviewer actually receives.
A dialog must be open before its containment or Escape trace can establish the
expected result. Keep a case out of a frozen comparison when preparation cannot
reach the required state; record that exclusion before any model sees it. A page
that contains a defect does not guarantee its bundle demonstrates it.

Give each fresh reviewer only one prepared bundle and the case's learner task.
Keep the source repository, manifest, key, counterpart, prior reviews and evaluation
notes outside its accessible context. Neutral filenames alone do not provide this
isolation. Audit generated bundle paths and text for answer-key hints before
freezing. Retain exact bundle, prompt, model, effort, tool configuration and input
hashes. Reuse the isolated execution discipline in `../pdf/README.md`; verify an
HTML bundle works with a runner before using it. This materializer does not call
models or provide sandboxing.

## Adjudication contract

Validate output through the production HTML importer before quality scoring.
Retain every attempted trial, including timeout, malformed output, rejected import
and contaminated runs. Report attempted, valid, failed and contaminated counts.
Protocol rejection is not a missed interaction defect. The manifest's
`protocolCases` lists separate integration checks; those checks never contribute
to quality denominators.

Blind model identity during manual adjudication. For every imported finding,
record its zero-based index, one verdict, supporting evidence IDs and a concrete
reason. Verdicts are `supported-defect`, `unsupported`, `context-question` or
`suggestion`. Only `supported-defect` maps a case's expected defect IDs. Record
unexpected real defects separately and preserve the frozen key. Apply any later
exclusion to every model. Keep actionable advice judgments separate from detection.

For each family and model, report these fractions with their raw counts:

- Detection: unique expected defects supported by findings divided by expected
  defects across valid trials. Duplicates detect a defect once per trial.
- Unsupported claims: unsupported findings divided by all adjudicated findings.
- Control false alarms: control trials with an unsupported defect claim divided
  by valid control trials. A context question alone is not a false alarm.
- Actionable advice: supported findings judged actionable divided by supported
  findings, including duplicate findings.

Use null when a denominator is zero. Report context questions and suggestions as
separate counts. Pair detection on valid trials with attempted-trial failures so
failed outputs cannot improve a model's apparent result. Do not combine families
into a ranking or infer conformance from these controls.

Retain measured input, cached-input and output tokens, provider-reported cost if
available, elapsed time and the pricing source/date for each attempt. Use null for
unavailable usage or cost rather than inventing estimates. Include retries and
failures in total cost. Compare models only on the same frozen inputs, tasks,
evidence, repeats and adjudication policy. Record any intentional changed factor.

The fixtures are original synthetic examples under the repository's `LICENSE`.
The [APG tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/),
[disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/),
[modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) and
[checkbox](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/) guidance informed task
expectations, checked 2026-09-15. Both manual and automatic tab activation are
valid. Home and End are optional, as is disclosure `aria-controls`. An APG
preference alone does not establish a WCAG failure.

Run `node --test bench/interaction-review/materialize.test.mjs` to check isolated
output, retained provenance and overwrite protection. Runtime evidence inspection
and adjudication remain required before a model comparison.

Run `node --test bench/interaction-review/evidence.test.ts` with Playwright Chromium
installed to verify fixture eligibility through the production collector. It checks
all 16 retained candidates, seven defect/control trace differences, manual tab
activation and the native-select evidence limit. This checks what evidence reaches
a reviewer; it does not score a model's interpretation.

The modal containment control uses modal semantics and explicit first/last focus
wrapping. A native-only version returned `body` at the browser focus boundary in
Chromium, which did not establish whether focus reached background content. That
ambiguous result is not a proven product defect.

## Scoring retained development attempts

Run `node bench/interaction-review/score.ts RUN.json`. The scorer imports valid
reviews through the production HTML importer and counts supplied judgments. It
makes no model calls and does not judge prose. `score.test.ts` checks counting and
rejection with synthetic retained packets, without a browser.

The run object uses `schemaVersion: "html-development-score-1"`, `keyPath`,
`keySha256`, `adjudicator` and `trials`. Set `adjudicator` to the actual method,
for example `model-assisted/root-reviewed`; do not imply independent human rating.
Keep model identity outside the first-pass adjudicator's context, then join the
judgments to attempts using their IDs. Paths resolve relative to RUN.json.

Every attempt has a unique `id`, `caseId`, positive integer `repeat`,
`model: { id, effort }` and `status`. Status is `valid`, `failed`, `invalid` or
`contaminated`. Nonvalid attempts require a concrete `reason`. They can retain
`reviewPath` and `reviewSha256` together, which the scorer verifies. Their quality
denominators are zero. Use the actual model and effort for each attempt, including
retries. Keep the runner's usage, cost and elapsed-time ledger beside the run.

Valid attempts also require `inputPath`, `bundlePath`, `manifestSha256`,
`evidenceSha256`, `promptPath`, `promptSha256`, `reviewPath`, `reviewSha256` and
`adjudications`. `inputPath` is the isolated directory containing only `index.html`.
`bundlePath` identifies the frozen preparation. The response must sit beside an
identical copy of its `manifest.json` and `evidence.json` so production import can
validate it. The scorer derives expected defect IDs directly from the hashed key.

Each adjudication contains `findingIndex`, `verdict`, `defectIds`, `evidenceIds`,
`actionable` and a concrete `reason`. Indices cover every finding exactly once.
Evidence IDs must identify that finding's candidate, rendered state or retained
traces; counterevidence may cite a different trace of the same candidate. Only
`supported-defect` can map expected defect IDs or mark advice actionable. To record
an unexpected supported defect, supply an `unexpectedDefect` reason and leave
`defectIds` empty. This preserves the key and does not increase detection.

The result groups counts by family, actual model and effort. Unsupported findings
count toward unsupported claims; an `unsupported` adjudication on a control
counts as a false alarm regardless of the model's category label. A
`context-question` adjudication alone is not a control false alarm. Fractions retain numerator and denominator and use null ratios for
zero denominators. Hashes bind files and declarations; they do not independently
prove blinding, model identity, completeness of the attempt ledger or judgment
quality. Compare the run with the runner's full ledger before reporting it.

## Schema output and one validation repair

`python3 bench/interaction-review/run.py PLAN.json NEW_OUTPUT_DIRECTORY` uses
the PDF runner's isolated trial setup. Each case needs `bundlePath` and the
original `inputPath`. Set `nodePath` to a compatible Node executable for the
host's production CLI validation. Protect source inputs, keys, previous runs
and agent histories with `protectedPaths`.

Choose `condition: "schema-output"` with `maxRepairs: 0`, or
`condition: "schema-output-one-repair"` with `maxRepairs: 1`. The model receives
`review.schema.json` as its output schema. The model cannot write into its trial
directory; the host saves the final response from CLI events as `review.json`.
Production import checks that response against the original input and retained
evidence. Schema-constrained generation does not replace import validation.

A rejected response may receive one fresh repair attempt with the same packet,
the rejected text and the literal validation error. The repair sees no answer
key or quality judgment. A timeout, failed provider process or failed validation
process does not trigger a repair. Both attempts retain their response, prompt,
logs, validation output and usage. The top-level status and `review.json` describe
the first attempt; `repairStatus` and `repair-1/` describe the optional correction.
A successful correction never turns the original attempt into a valid one.

Report first-attempt validity and workflow validity separately, with primary,
repair and total costs. Quality scoring must identify which response it judged.
Keep prior trials frozen when changing the collector, schema or prompt; changes
to several factors measure the workflow as a whole, not any one improvement.
