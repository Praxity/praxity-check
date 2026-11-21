# 0003: Review evidence and report contracts

## Status

Accepted. Records existing behaviour; no runtime change.

## Context

Retained evidence must remain importable and distinguish observed facts from inference, missing coverage and reviewer judgement.

## Decision

- In `src/html-review.ts`, `MAX_RETAINED_CANDIDATES` is an accepted-format limit independent of future collection budgets. `bundleSchema` bounds generated enums for structured-output providers, then relies on production import to validate every reference even when the schema falls back to a format constraint.
- In `src/interaction-review.ts`, `SURFACE_IDS` exports only the IDs from `SURFACES`. The importer, `validateEvidence` in `src/html-review.ts`, uses those IDs to validate retained candidate surfaces. Selectors and rules remain owned by `src/interaction-review.ts`. `dynamicState` retains page-level live regions because announcements may occur outside the component. `summarizeRetainedState` compares only retained fields; it cannot establish arbitrary DOM mutations or task completion. `reorderTraces` records list state, neighbours and absolute position because moving an item invalidates a positional selector. `prepareInteractionReview` observes behaviour before deduplicating: identical markup can behave differently at the keyboard.
- In `src/review-runner.ts`, `classifyReview` provides reviewer hints only, never findings or a coverage filter. `codexReview` forwards only runtime locations, Codex authentication and proxy settings because course text is untrusted. Early stdin closure leaves process errors and exit status responsible for failure. `runPreparedReview` includes optional classifier instructions in the normal manual-review entry point.
- In `src/report.ts`, `createReport` keeps whole-page and skipped-state coverage separate from occurrence-level evidence. `humanSummary` and `countAtOrAbove` use the selected confidence floor for display and exit status; high is the default so only measured, unambiguous failures stop a build. Medium-confidence custom checks can be selected explicitly.
- In `src/pdf-review.ts`, `verifiedBundle` checks evidence identity but cannot prove that a reviewer inspected an image. `validatePdfReviewBundleSelection` rejects unsupported versions before evidence reads and reuses verified bundles. In `src/pdf-compare.ts`, `validateComparisonReport` refuses unknown policy fields so future policies cannot compare as silently equivalent.
- In `src/pdf.ts`, `pdfCli` checks inode identity as well as resolved paths to protect hardlink and symlink aliases. Publishing output replaces a directory entry instead of writing through links.

Sources: corresponding comments and implementations at `43dbc10`; `docs/report-schema-v4.md`, `docs/pdf-report-v1.md`, `test/html-review.test.ts`, `test/interaction-review.test.ts`, `test/review-runner.test.ts`, `test/report.test.ts`, `test/pdf-review.test.ts` and `test/pdf.test.ts`. The deleted environment-policy comment cited https://learn.chatgpt.com/docs/config-file/environment-variables.

## Consequences

Changes to these rules require updated evidence and tests through the affected module interfaces. Removing comments does not broaden what the existing checks establish.
