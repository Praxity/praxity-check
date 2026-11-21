# 0006: Validator and VoiceOver compatibility

## Status

Accepted. Records existing behaviour; no runtime change.

## Context

Upstream versions and evidence limits constrain what Check can claim from validation and screen-reader capture.

## Decision

- In `src/pdf-accessibility.ts`, `feedback` provides source-level guidance only for verified ISO 14289-1:2014 rules; other versions retain validator wording. `parseVeraPdf` records retained and omitted failed checks because veraPDF caps stored assertions globally even with `--maxfailuresdisplayed -1`. A complete rule summary does not prove every assertion was retained.
- In `src/screen-reader.ts`, `loadVoiceOver` uses Guidepup 0.24.1. The recorded 0.34.0 reproduction rewrote VoiceOver preferences on each start and failed to remove a directory at the portable `.scrd.vou` path without recursion. A newer version requires a successful Mac run before changing the pin.
- `withCauses` includes Guidepup's nested cause chain in the error message because the CLI displays only that message. `eventsNearExpected` currently clusters native log bursts near the observed phrase; this is timing evidence rather than a supported text-bearing speech-event stream.

Sources: comments and implementations at `43dbc10`; `test/pdf-accessibility.test.ts`, `test/screen-reader.test.ts` and `docs/evidence/live-region-capture-2026-08-11/README.md`. This ADR records the existing compatibility evidence, not a new VoiceOver run.

## Consequences

Changes to these rules require updated evidence and tests through the affected module interfaces. Removing comments does not broaden what the existing checks establish.
