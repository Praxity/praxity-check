# 0001: HTML check precision

## Status

Accepted. Records existing behaviour; no runtime change.

## Context

HTML audits must distinguish a measured defect from missing evidence, browser behaviour and the scanner's own restrictions.

## Decision

- In `src/checks.ts`, `Finding`, `ReviewItem`, `runAxe` and `scopeCoverage` keep unresolved evidence non-gating, distinguish incomplete axe results from violations, demote best-practice advice, and report dropped or inaccessible coverage. A check that examined nothing must not appear clean.
- `settle` waits for the first rendered content because course launchers can populate an empty shell after load. It does not emulate an LMS. `triage` excludes network-blocked shells and inaccessible frame shells; frame dimensions alone cannot establish that a page is a launcher. Otherwise the scanner would report its own network restrictions as course defects.
- `MAX_FOCUS_CHECKS`, `MAX_TRAPS`, `MAX_ESCAPE_TABS` and `MAX_KEYBOARD_WALK_MS` bound work while retaining coverage notes. Extra escape tabs accommodate native media controls and date/time segments; keyboard walking must leave time for other checks.
- `MARK` and `MARK_ATTR` bind the dataset property's camel-case spelling to the CSS attribute's kebab-case spelling. A mismatch yields no elements and can silently report success. `UNIQUE_SELECTOR` emits source-backed selectors rather than injected identifiers.
- `UA_SIZED_CONTROLS` and `runAxe` apply WCAG 2.5.8's User Agent Control exception narrowly to native controls without authored sizing. If querying a target fails, the finding remains. Enable target-size and heading-order checks explicitly so axe defaults cannot silently change coverage. Glyph-only controls use `nonTextContrast`.
- `localResources` checks same-origin integrity only. `LISTENER_PROBE` uses Chromium's command-line listener inspection without mutating the page. `mouseOnlyControlsFrom` excludes delegated keyboard handling; `characterKeyShortcutsFrom` excludes modifier or focus guards that static inspection cannot disprove. `DOWN_ACTION` and `pointerCancellationFrom` identify completion on down events, including clearing a field, while excluding press-feedback-only styling and same-target up/cancel paths.
- `pauseStopHide` includes active transitions and applies the essential/progress exceptions. `audioAutoplay` observes more than three seconds of audio before requiring a control.
- `keyboardWalk` preserves actual element identity, including controls outside its focusable selector. Repeated host identity inside native shadow controls does not prove a trap. Escape probes retain handles, reverse native segment movement, restore edits and selection, and reconfirm after restoration. Continue walking after a trap; returning immediately would hide later traps.
- `focusIndicators` compares computed style because the recorded headless Chromium reproduction matched `:focus-visible` without painting screenshot-visible rings. Include labels, siblings, ancestors and generated pseudo-elements. Ignore pseudo-elements that paint nothing, compare the same representatives in both states, and keep findings medium confidence because styles are a proxy for rendered output.
- `stateContrast` measures text contrast on hover without treating every hover fill as a component-identification cue. `nonTextContrast` uses solid CSS/SVG paint, actual stroke positions and visible labels/icons; transparent borders do not paint a cue. Complex paint and semantic importance require review, so findings stay medium confidence.
- `focusNotObscured` requires total opaque coverage for AA; partial overlap concerns AAA. `reflow` uses a 320 CSS-pixel viewport and refers exemption-dependent overflow for review. `textScale` requires document opt-in; `textSpacing` requires clipping by an overflow ancestor because overlap alone is inconclusive.
- `altTextQuality` matches entire filenames or unsubstituted templates, leaving descriptions ending in an extension and context-dependent meaning to review. `USELESS_LINK_TEXT` stays narrow because WCAG 2.4.4 allows context; `linkTextQuality` uses accessible names and reports generic wording as advisory when context can resolve it. Its separate repeated-name/different-destination rule retains the existing implementation.

Sources: comments and implementations in `src/checks.ts` at `43dbc10`, the defect/clean controls in `test/checks.test.ts`, and WCAG 2.2 criteria 1.4.2, 1.4.3, 1.4.10, 1.4.11, 1.4.12, 2.1.1, 2.2.2, 2.4.4, 2.4.9, 2.4.11, 2.4.12, 2.5.2 and 2.5.8. Historical false-positive counts in comments describe earlier observations, not new validation.

## Consequences

Every native check needs a known-failing fixture as well as a clean control. An empty result alone cannot distinguish a passing page from a broken check that examined nothing. Keep each defect fixture limited to one mechanism so a neighbouring rule cannot receive credit. This records the test rationale in `test/checks.test.ts` at `43dbc10`.

Changes to these rules require updated evidence and tests through the affected module interfaces. Removing comments does not broaden what the existing checks establish.
