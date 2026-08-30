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
versions. Rule metadata also carries its source version.

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
