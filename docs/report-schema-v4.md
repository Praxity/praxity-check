# Report schema v4

Schema v4 adds evidence about what ran. It does not change the CLI threshold or
turn unanswered checks into passes.

## Existing result arrays

`findings` and `needsReview` remain the main occurrence arrays. Each occurrence
now has:

- `occurrenceId`, derived from rule, page, selector, and state after known
  generated component-ID fragments are removed;
- `state`, either `initial`, `dark`, or a declared scenario ID;
- `disposition`, initially `unreviewed`.

Changing an evidence excerpt does not change the occurrence ID. Changing the
target or rendered state does.

## Baselines and dispositions

`--baseline <report.json>` accepts a previous Praxity Check schema-v4 report.
When supplied:

- current occurrences gain `comparison: "new" | "existing"`;
- prior occurrences absent from the current report appear in
  `changes.resolved`;
- `baseline` records the prior tool version and target;
- an `accepted` or `falsePositive` disposition carries to the same occurrence
  in the same result array.

Reviewed dispositions require:

```json
{
  "disposition": "accepted",
  "review": {
    "reason": "Specific reason for the decision",
    "owner": "Named responsible person or team",
    "reviewedAt": "2026-08-29"
  }
}
```

Disposition does not change the evaluation outcome. An accepted finding remains
`failed`, stays in `findings`, and continues to affect the existing CLI exit
threshold. `resolved` is a change between runs, not a disposition. Without a
baseline, `comparison`, `baseline`, and `changes` are absent.

## Rules and evaluations

`rules` contains the metadata used in the run. Axe entries retain axe's source
tags and ACT rule IDs. Native entries expose structured WCAG criteria when the
finding basis names them.

`evaluations` uses these outcomes:

| Outcome | Meaning |
| --- | --- |
| `failed` | The rule produced at least one finding for the page and state. |
| `cantTell` | The automated result needs a person to decide. |
| `passed` | The engine evaluated an applicable rule and found no failure. |
| `inapplicable` | The engine established that the rule had no applicable target. |
| `untested` | A named check or page audit did not run, with a reason. |

Axe supplies all four rule outcomes it can establish. Native checks currently
emit `failed` and `cantTell`. No native result appears for a quiet rule until
that implementation can distinguish a pass from inapplicability.

An `untested` entry has `type: "check"` and a check name rather than a rule ID.
This keeps execution failure separate from a standards result.

## Environment and rulesets

`environment` records the Node runtime, Chromium version, viewport, and colour
scheme used by `check`. `rulesets` records the Praxity Check and axe-core
versions. Rule metadata also carries its source version. In an inference-only
import, no browser runs: `environment.browser`, `viewport` and `colorScheme` are
`null`. The Node runtime still describes the import process. Browser capture
conditions remain under each imported review's `retainedEvidence.environment`.

`scenarios` retains the validated page, state ID, and actions supplied with
`--scenarios`. A scenario that cannot run produces an `untested` evaluation.

## Migration from v3

1. Accept `schemaVersion: 4`.
2. Continue reading `findings`, `needsReview`, `counts`, `pages`, and `network`.
   Their roles have not changed.
3. Ignore unknown fields if the consumer does not need evidence coverage.
4. Use `occurrenceId` instead of message text or array position for identity.
5. Use `evaluations` when reporting pass, inapplicable, or untested coverage.
   Absence from `findings` is not a pass.
6. Treat `disposition` independently from the evaluation outcome. Existing v4
   reports without it are accepted as baselines and treated as `unreviewed`.

## Imported HTML interaction reviews

`inferenceReviews` holds validated model observations separately from the
machine `findings`, `needsReview` and `evaluations` arrays. The shared `feedback`
view groups them by category and retains `method: "inference"`, model provenance,
location and evidence references. Inference-only reports leave machine result
arrays empty and mark deterministic checks `untested` in `feedback.coverage`.
Imported observations do not affect the deterministic failure exit code.

The optional `contentSha256` identifies the private snapshot used for bundle
preparation or review import. It hashes sorted relative file paths and each
file's SHA-256, so a folder and ZIP with identical file contents share a revision.
Local assets count, including CSS and scripts. Ordinary deterministic reports
without imported reviews omit this hash and remain unbound to a content revision.

New HTML reviews use `schemaVersion: "html-review-2"`. Version 1 reviews remain
importable. An HTML review stays beside the bundle's
`manifest.json` and `evidence.json`. The import verifies its content revision and
retained evidence hash. Findings identify the primary candidate, its page and
rendered DOM state; executed-behavior claims must cite its recorded action traces.
Coverage lists reviewed pages and candidates, not all duplicate occurrences or
whole-page accessibility. The full schema travels in `review.schema.json`.

A review file is limited to 2 MiB and 200 findings. Retained evidence is limited
to 16 MiB. Unknown identities, unsupported domains, invented fields and stale
local assets reject the import. Hashes bind artifacts, not reviewer honesty or
current runtime state. Review questions and suggestions remain distinct from
model observations of defects, and none establishes conformance.

Version 2 adds `claim: "coverage"` for a `needs-context` question about missing
evidence. It may have no action traces and cannot represent an observed defect
or suggestion. `executed-behavior` still requires a retained trace. A coverage
question asks for a check before proposing a source change.

Exported schemas bind content and evidence hashes and constrain reference values
for small packets. Production import still verifies reference relationships,
unique lists and evidence limits, including after schema-constrained generation.

## Shared feedback fields

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
