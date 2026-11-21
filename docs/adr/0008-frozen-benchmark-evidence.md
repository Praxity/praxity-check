# 0008: Frozen benchmark evidence

## Status

Accepted. Records existing behaviour; no runtime change.

## Context

Benchmark runners must keep trial inputs independent, retain failures and avoid mistaking extracted text for proof of visible content.

## Decision

- In `bench/interaction-review/materialize.mjs`, `materialize` creates a new directory without recursive reuse so frozen trials cannot be overwritten. In `bench/interaction-review/run.py`, `execute_html_trial` retains final responses and usage even after a CLI failure.
- In `bench/interaction-review/score.ts`, `scoreRun` counts blinded adjudications instead of deciding whether finding prose is true. A copied review response must retain the exact frozen packet, and attempts for the same case must use identical evidence.
- In `bench/pdf/expanded.py`, `Page` uses Courier's exact 600-unit advance; other fonts export origins only. `generate` shuffles documents before assigning independent opaque case/variant IDs. `main` in `bench/pdf/expanded.test.py` distinguishes extraction from visibility: clipped or overprinted text can remain in PDF source. `reference` in `bench/pdf/generate.py` uses similar grayscale brightness to prevent colour alone from providing a reliable routing key.
- In `bench/pdf/run.py`, `profile_for` protects parent directories from renames that could move protected files beyond sandbox rules. `run` proves deny rules in preflight before a paid model call and retains rejected bundles as planned failed attempts.
- `comment-baseline.json` excludes the unchanged upstream ACT focus-visible stylesheet. Its comment is part of imported test data, not maintained product code. Preserve the fixture subset and upstream licensing described in `bench/act/README.md`.

Sources: corresponding comments and implementations at `43dbc10`; `bench/interaction-review/materialize.test.mjs`, `bench/interaction-review/run.test.py`, `bench/interaction-review/score.test.ts`, `bench/pdf/expanded.test.py`, `bench/pdf/run.test.py` and `bench/act/README.md`.

## Consequences

Changes to these rules require updated evidence and tests through the affected module interfaces. Removing comments does not broaden what the existing checks establish.
